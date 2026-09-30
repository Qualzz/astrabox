import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, rename, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_GENERATION } from './codex-bridge.js';
import { createInstalledCodexBridge } from './installed-codex.js';
import { hashCartridge, inspectCartridge, validateCartridge } from './validate-cartridge.js';
import { HUB_INSTRUCTIONS, HUB_TOOLS, routeHubTool, listGames } from './hub-router.js';

const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
const exists = file => access(file).then(() => true, () => false);
const textItem = text => ({ type: 'inputText', text });
const publicError = error => String(error?.message ?? error).replace(/(?:sk-[\w-]+|Bearer\s+\S+)/gi, '[credential]').slice(0, 1600);

export class Workshop extends EventEmitter {
  constructor({ root, origin, bridge = createInstalledCodexBridge(root), validator = validateCartridge }) {
    super();
    this.root = root;
    this.origin = origin;
    this.bridge = bridge;
    this.validator = validator;
    this.sessions = new Map();
    this.creations = new Map();
    this.thumbnails = new Map();
    this.data = path.join(root, '.arcade');
    this.bridge.on('notification', event => { this.handleNotification(event).catch(error => this.emit('diagnostic', publicError(error))); });
    this.bridge.on('request', event => { this.handleRequest(event).catch(error => this.bridge.respondError(event.id, -32000, publicError(error))); });
    this.bridge.on('disconnect', () => {
      for (const session of this.sessions.values()) {
        session.loaded = false;
        session.turnId = null;
        session.voice = false;
        session.rejectVoice?.(new Error('Connexion Codex interrompue.'));
        this.send(session, { type: 'voice-closed' });
        this.status(session, 'error', 'Connexion Codex interrompue. Le jeu reste disponible.');
      }
    });
  }

  async initialize() {
    await mkdir(path.join(this.data, 'workspaces'), { recursive: true });
    let stored = [];
    try { stored = JSON.parse(await readFile(path.join(this.data, 'sessions.json'), 'utf8')); } catch {}
    for (const item of stored) {
      if (!/^[a-f0-9-]{36}$/.test(item.id) || !(item.mode === 'hub' ? item.gameId === null : slug.test(item.gameId)) || typeof item.threadId !== 'string') continue;
      this.sessions.set(item.id, this.hydrate(item));
    }
  }

  hydrate(item) {
    return { mode: 'game', hasTurns: false, ...item, workspace: path.join(this.data, 'workspaces', item.id), loaded: false, turnId: null, voice: false,
      hubCalls: new Map(),
      state: 'idle', message: 'Atelier prêt.', events: [], captures: new Map(), repairing: 0, context: null,
      voiceGeneration: 0, voiceStopping: false, realtimeItems: new Map(), canonicalTranscripts: false };
  }

  async persist() {
    const items = [...this.sessions.values()].map(({ id, mode, gameId, threadId, published, revision, hasTurns, lastGameId }) => ({ id, mode, gameId, threadId, published, revision, hasTurns, lastGameId }));
    const temp = path.join(this.data, 'sessions.json.tmp');
    // Serialize metadata writes: a session contains one current staging copy, never version history.
    this.persistence = (this.persistence ?? Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(temp, JSON.stringify(items, null, 2));
      await rename(temp, path.join(this.data, 'sessions.json'));
    });
    return this.persistence;
  }

  async accountStatus() {
    try {
      await this.bridge.connect();
      const info = await this.bridge.request('account/read', { refreshToken: false });
      return { connected: true, authenticated: Boolean(info.account), requiresLogin: !info.account && info.requiresOpenaiAuth,
        authType: info.account?.type ?? null, voice: 'experimental', message: info.account ? 'Codex connecté.' : 'Connexion Codex à vérifier.' };
    } catch (error) { return { connected: false, authenticated: false, voice: 'experimental', message: publicError(error) }; }
  }

  async session({ sessionId, gameId, context, mode } = {}) {
    if (gameId != null && !slug.test(gameId)) throw new Error('Identifiant de jeu invalide.');
    const hub = mode === 'assistant' || mode === 'hub' || context?.mode === 'hub';
    // The view's game ID lives in context, not in the conversation identity.
    if (hub) gameId = null;
    if (sessionId && this.sessions.has(sessionId)) {
      const candidate = this.sessions.get(sessionId);
      if ((candidate.mode === 'hub') === hub && (gameId == null || candidate.gameId === gameId)) {
        await this.load(candidate);
        if (context) await this.updateContext(candidate, context);
        return this.describe(candidate);
      }
    }
    // Independent new requests must never collapse into the same cartridge.
    if (!hub && !gameId) return this.createSession(undefined, context);
    const key = hub ? 'arcade-assistant' : gameId;
    if (hub) {
      const prior = [...this.sessions.values()].find(s => s.mode === 'hub');
      if (prior) { await this.load(prior); if (context) await this.updateContext(prior, context); return this.describe(prior); }
    }
    if (this.creations.has(key)) return this.creations.get(key);
    const create = this.createSession(gameId, context, hub ? 'hub' : 'game').finally(() => this.creations.delete(key));
    this.creations.set(key, create);
    return create;
  }

  async createSession(gameId, context, mode = 'game') {
    const status = await this.accountStatus();
    if (!status.connected || status.requiresLogin) throw new Error(status.requiresLogin ? 'Codex n’est pas connecté. Lance codex login dans le terminal, puis réessaie.' : status.message);
    // At most one workspace/thread per published game. Hub resumes through its client session id.
    const prior = gameId && [...this.sessions.values()].find(s => s.gameId === gameId);
    if (prior) { await this.load(prior); if (context) await this.updateContext(prior, context); return this.describe(prior); }
    const id = randomUUID();
    const session = this.hydrate({ id, mode, gameId: mode === 'hub' ? null : gameId ?? `game-${id.slice(0, 8)}`, published: Boolean(gameId), threadId: null });
    if (mode !== 'hub') await mkdir(path.join(session.workspace, 'cartridge'), { recursive: true });
    await mkdir(path.join(session.workspace, 'reference'), { recursive: true });
    if (gameId) {
      const source = path.join(this.root, 'cartridges', gameId);
      if (!await exists(path.join(source, 'game.json'))) throw new Error('Jeu introuvable.');
      await cp(source, path.join(session.workspace, 'cartridge'), { recursive: true });
      session.revision = (await inspectCartridge({ directory: source, expectedId: gameId })).revision;
    } else if (mode !== 'hub') {
      await writeFile(path.join(session.workspace, 'cartridge', 'game.json'), JSON.stringify({ id: session.gameId, title: 'Nouveau jeu', description: 'À concevoir avec le visiteur.', maxPlayers: 1, entry: 'game.js', accent: '#f3ec91' }, null, 2));
      await writeFile(path.join(session.workspace, 'cartridge', 'config.json'), '{}\n');
    }
    await this.refreshReferences(session);
    this.sessions.set(id, session);
    try { await this.load(session); if (context) await this.updateContext(session, context); await this.persist(); }
    catch (error) { this.sessions.delete(id); await rm(session.workspace, { recursive: true, force: true }); throw error; }
    return this.describe(session);
  }

  describe(session) { return { sessionId: session.id, threadId: session.threadId, mode: session.mode, gameId: session.gameId, published: session.published }; }
  get(id) { const session = this.sessions.get(id); if (!session) throw new Error('Session introuvable.'); return session; }

  async refreshReferences(session) {
    await mkdir(path.join(session.workspace, 'reference'), { recursive: true });
    for (const [from, to] of [['docs/CARTRIDGE_CONTRACT.md', 'CARTRIDGE_CONTRACT.md'], ['assets/audio/catalog.json', 'audio-catalog.json'], ['src/midi.js', 'midi.mjs']]) {
      if (await exists(path.join(this.root, from))) await cp(path.join(this.root, from), path.join(session.workspace, 'reference', to));
    }
    const instructions = session.mode === 'hub' ? HUB_INSTRUCTIONS : await readFile(path.join(this.root, 'prompts/cartridge-maker.md'), 'utf8');
    await writeFile(path.join(session.workspace, 'AGENTS.md'), instructions);
  }

  policy(session) { return session.mode === 'hub' ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [session.workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true }; }

  async load(session) {
    if (session.loaded) return;
    if (session.loading) return session.loading;
    session.loading = (async () => {
      await this.bridge.connect();
      await this.refreshReferences(session);
      const developerInstructions = session.mode === 'hub' ? HUB_INSTRUCTIONS : `${await readFile(path.join(this.root, 'prompts/cartridge-maker.md'), 'utf8')}\nIdentifiant fixe de la cartouche : ${session.gameId}.\n${session.published ? 'Modifie le jeu existant dans cartridge/.' : 'Crée un nouveau jeu indépendant dans cartridge/, lorsque le visiteur le demande.'}`;
      const sandbox = session.mode === 'hub' ? 'read-only' : 'workspace-write';
      const dynamicTools = session.mode === 'hub' ? HUB_TOOLS : [
        { type: 'function', name: 'capture_game', description: 'Demande une capture fraîche du jeu affiché et son état public. Ne capture pas le bureau.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { type: 'function', name: 'validate_game', description: 'Compile et exécute un smoke test réel de la cartouche en préparation. Retourne un rapport, sans publication.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ];
      if (session.threadId) {
        try { await this.bridge.request('thread/resume', { threadId: session.threadId, cwd: session.workspace, approvalPolicy: 'never', sandbox, developerInstructions,
          model: DEFAULT_GENERATION.model, serviceTier: DEFAULT_GENERATION.serviceTier, config: { model_reasoning_effort: DEFAULT_GENERATION.effort } }); }
        catch (error) {
          // Codex doesn't persist an empty thread before its first turn. Never silently
          // replace a conversation that already contains exchanges.
          if (!session.hasTurns && /no rollout found/i.test(error.message)) session.threadId = null;
          else throw error;
        }
      }
      if (!session.threadId) {
        const response = await this.bridge.request('thread/start', { cwd: session.workspace, approvalPolicy: 'never', sandbox, runtimeWorkspaceRoots: [session.workspace], developerInstructions, dynamicTools,
          model: DEFAULT_GENERATION.model, serviceTier: DEFAULT_GENERATION.serviceTier,
          config: { model_reasoning_effort: DEFAULT_GENERATION.effort, 'sandbox_workspace_write.network_access': false, 'sandbox_workspace_write.exclude_tmpdir_env_var': true, 'sandbox_workspace_write.exclude_slash_tmp': true } });
        session.threadId = response.thread.id;
      }
      // Sticky policy also applies to turns delegated by native realtime, not only text turns.
      await this.bridge.request('thread/settings/update', { threadId: session.threadId, cwd: session.workspace, approvalPolicy: 'never', sandboxPolicy: this.policy(session), ...DEFAULT_GENERATION });
      session.loaded = true;
    })().finally(() => { session.loading = null; });
    return session.loading;
  }

  send(session, event) {
    const value = { ...event, sessionId: session.id, timestamp: Date.now() };
    if (['status', 'message'].includes(value.type)) {
      session.events.push(value);
      session.events = session.events.slice(-40);
    }
    this.emit(`session:${session.id}`, value);
  }
  status(session, state, message) {
    session.state = state; session.message = message;
    this.send(session, { type: 'status', state, message });
    this.emit('global', { type: 'workshop-status', sessionId: session.id, gameId: session.gameId, state, message });
  }

  async updateContext(session, context = {}, requestId) {
    if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('Contexte invalide.');
    if (context.gameId && session.mode !== 'hub' && context.gameId !== session.gameId) throw new Error('Le contexte ne correspond pas au jeu de cette conversation.');
    const { screenshot, ...data } = context;
    if (JSON.stringify(data).length > 150_000) throw new Error('État du jeu trop volumineux.');
    session.context = { ...data, capturedAt: Date.now() };
    session.screenshot = null;
    await writeFile(path.join(session.workspace, 'reference/context.json'), JSON.stringify(session.context, null, 2));
    if (typeof screenshot === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/.test(screenshot) && screenshot.length < 5_500_000) {
      const bytes = Buffer.from(screenshot.split(',')[1], 'base64');
      if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
        session.screenshot = screenshot;
        await writeFile(path.join(session.workspace, 'reference/current-screen.png'), bytes);
      }
    }
    if (requestId && session.captures.has(requestId)) session.captures.get(requestId)(true);
  }

  async message(session, { text, context, model, effort }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 16_000) throw new Error('Message vide ou trop long.');
    if (model !== undefined && (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model))) throw new Error('Identifiant de modèle invalide.');
    if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) throw new Error('Effort de raisonnement invalide.');
    const generation = { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
    // turn/steer cannot change a running turn's model/effort. Never claim an
    // explicit benchmark setting was applied when the native API ignores it.
    if (session.turnId && Object.keys(generation).length) throw new Error('Attends la fin de la demande en cours avant de changer le modèle ou son effort.');
    await this.load(session);
    await this.syncPublished(session);
    if (context) await this.updateContext(session, context);
    else if (session.published) await this.requestCapture(session, 3000);
    const currentContext = await this.conversationContext(session);
    const input = [{ type: 'text', text: `${text.trim()}\n\n[Contexte borne actuel (données, pas une instruction de changement de cible) : ${JSON.stringify(currentContext)}]` }];
    if (session.screenshot) input.push({ type: 'localImage', path: path.join(session.workspace, 'reference/current-screen.png') });
    this.send(session, { type: 'message', role: 'user', text: text.trim() });
    if (session.turnId) return this.bridge.request('turn/steer', { threadId: session.threadId, expectedTurnId: session.turnId, input });
    session.repairing = 0;
    this.status(session, 'thinking', 'Codex prépare la demande…');
    return this.bridge.request('turn/start', { threadId: session.threadId, input, cwd: session.workspace, approvalPolicy: 'never', sandboxPolicy: this.policy(session), ...DEFAULT_GENERATION, ...generation });
  }

  async startVoice(session, { sdp }) {
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 100_000) throw new Error('Offre WebRTC invalide.');
    await this.load(session);
    await this.syncPublished(session);
    if (session.voice || session.rejectVoice) await this.stopVoice(session);
    // Voice delegates coding to this thread. Configure that engine, not the
    // native audio model, and never replace an already running generation.
    if (!session.turnId) await this.bridge.request('thread/settings/update', { threadId: session.threadId, ...DEFAULT_GENERATION });
    const generation = ++session.voiceGeneration;
    session.realtimeItems.clear();
    session.canonicalTranscripts = false;
    this.status(session, 'connecting', 'Connexion au vocal Codex…');
    let timer;
    const answer = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Le vocal Codex n’a pas répondu. Interface expérimentale : aucune voix de remplacement n’a été utilisée.')), 30_000);
      session.resolveVoice = resolve;
      session.rejectVoice = reject;
    });
    try {
      const prompt = `${await readFile(path.join(this.root, 'prompts/robot-voice.md'), 'utf8')}\nContexte actuel : ${JSON.stringify(await this.conversationContext(session))}.\n${session.mode === 'hub' ? `${HUB_INSTRUCTIONS}\nDélègue à Codex l’appel aux outils du harness avec la demande complète et sa cible, depuis cet écran sans demander au visiteur de se déplacer.` : 'Le code de CE jeu est dans cartridge/ ; les instructions sont dans AGENTS.md.'}`;
      // Await both promises immediately so an early native error cannot become an unhandled rejection.
      // Native v3 (CLI 0.153.1): verified WebRTC handshake; the default failed AVAS's Quicksilver header check.
      const [result] = await Promise.all([answer, this.bridge.request('thread/realtime/start', {
        threadId: session.threadId, version: 'v3', outputModality: 'audio', transport: { type: 'webrtc', sdp }, prompt, includeStartupContext: true,
        // Keep live native handoffs enabled. Ending the call is never a submit action.
        clientManagedHandoffs: false, flushTranscriptTailOnSessionEnd: false,
      })]);
      if (session.voiceGeneration !== generation) throw new Error('Connexion vocale annulée.');
      session.voice = true;
      // SDP negotiation is not evidence that the microphone transport is connected.
      // The browser's local voice-state confirms its actual peer connection.
      this.status(session, 'connecting', 'Liaison audio en cours…');
      return { sdp: result };
    } catch (error) {
      if (session.voiceGeneration === generation) {
        session.voice = false;
        await this.bridge.request('thread/realtime/stop', { threadId: session.threadId }).catch(() => {});
        this.status(session, 'error', `Vocal indisponible : ${publicError(error)}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (session.voiceGeneration === generation) { session.resolveVoice = null; session.rejectVoice = null; }
    }
  }

  async conversationContext(session) {
    if (session.mode !== 'hub') return { gameId: session.gameId, ...session.context, verification: session.lastVerification ?? null };
    return { ...session.context, lastRequestedGameId: session.lastGameId ?? null,
      games: await listGames(this.root),
      jobs: [...this.sessions.values()].filter(s => s.mode !== 'hub').map(s => ({ gameId: s.gameId, state: s.state, message: s.message })),
    };
  }

  async stopVoice(session) {
    session.voiceGeneration += 1;
    session.voiceStopping = true;
    session.rejectVoice?.(new Error('Connexion vocale annulée.'));
    session.resolveVoice = null;
    session.rejectVoice = null;
    try {
      if (session.loaded) await this.bridge.request('thread/realtime/stop', { threadId: session.threadId }).catch(() => {});
    } finally {
      session.voice = false;
      session.voiceStopping = false;
      this.send(session, { type: 'voice-closed' });
      if (!session.turnId) this.status(session, 'idle', 'Micro coupé.');
    }
  }

  async interrupt(session) {
    if (session.turnId) await this.bridge.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId });
    else await this.stopVoice(session);
  }

  async validate(session) {
    if (session.mode === 'hub') throw new Error('Le menu ne possède pas de cartouche à valider.');
    const directory = path.join(session.workspace, 'cartridge');
    const revision = await hashCartridge(directory);
    if (session.validationResult?.revision === revision) return session.validationResult;
    this.status(session, 'testing', 'Vérification de la cartouche dans le navigateur…');
    const result = await this.validator({ directory, expectedId: session.gameId, previewUrl: `${this.origin}/preview.html?session=${session.id}` });
    if (result.revision === revision && await hashCartridge(directory) === revision) session.validationResult = result;
    return result;
  }

  async getThumbnail(gameId, revision) {
    if (!slug.test(gameId)) return null;
    if (!this.thumbnails.has(gameId)) {
      let saved = null;
      try { saved = JSON.parse(await readFile(path.join(this.data, 'thumbnails', `${gameId}.json`), 'utf8')); } catch {}
      if (!this.thumbnails.has(gameId)) this.thumbnails.set(gameId, saved);
    }
    const saved = this.thumbnails.get(gameId);
    return saved?.revision === revision && typeof saved.screenshot === 'string'
      && saved.screenshot.startsWith('data:image/png;base64,') ? saved.screenshot : null;
  }

  async verifyPublished(session, revision) {
    const directory = path.join(this.root, 'cartridges', session.gameId);
    const current = async () => !this.closed && session.revision === revision && await hashCartridge(directory) === revision;
    if (!await current()) return;
    try {
      const result = session.validationResult?.revision === revision ? session.validationResult
        : await this.validator({ directory, expectedId: session.gameId, previewUrl: `${this.origin}/preview.html?game=${session.gameId}` });
      // Files may have been replaced while the browser was running. A stale
      // check must not report success/failure or attach its picture to a new edit.
      if (result.revision !== revision || !await current()) return;
      session.lastVerification = { revision, ok: true, message: 'Vérification navigateur réussie.' };
      const screenshot = result.report?.browser?.screenshot;
      if (typeof screenshot === 'string' && screenshot.startsWith('data:image/png;base64,') && screenshot.length < 5_500_000) {
        // One disposable thumbnail cache per game, outside its code/config.
        // Updating this image must never trigger a second gameplay hot reload.
        const thumbnail = { revision, screenshot };
        const filename = path.join(this.data, 'thumbnails', `${session.gameId}.json`);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(`${filename}.tmp`, JSON.stringify(thumbnail));
        await rename(`${filename}.tmp`, filename);
        this.thumbnails.set(session.gameId, thumbnail);
        if (await current()) this.emit('global', { type: 'game-thumbnail-updated', gameId: session.gameId, revision, sessionId: session.id });
      }
    } catch (error) {
      if (!await current()) return;
      session.lastVerification = { revision, ok: false, message: publicError(error), errors: error.report?.errors };
      // Publication is already durable. Do not roll back a live game or launch
      // another generation over a visitor's newer request.
      if (!session.turnId) this.status(session, 'error', `Modification publiée ; vérification en échec : ${publicError(error)}`);
    }
    if (await current()) this.send(session, { type: 'verification', ...session.lastVerification });
  }

  async requestCapture(session, timeout = 8000, gameId = session.gameId) {
    const requestId = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { session.captures.delete(requestId); resolve(false); }, timeout);
      session.captures.set(requestId, value => { clearTimeout(timer); session.captures.delete(requestId); resolve(value); });
      const event = { type: 'capture-request', requestId, sessionId: session.id, gameId };
      this.send(session, event);
      this.emit('global', event);
    });
  }

  async syncPublished(session) {
    if (!session.published || session.turnId || session.publishing) return;
    const destination = path.join(this.root, 'cartridges', session.gameId);
    const current = await inspectCartridge({ directory: destination, expectedId: session.gameId });
    if (current.revision === session.revision) return;
    const working = path.join(session.workspace, 'cartridge');
    const staged = await inspectCartridge({ directory: working, expectedId: session.gameId });
    if (staged.revision !== session.revision) throw new Error('Le jeu a aussi changé en dehors de cette conversation. La tentative en cours est conservée ; résous ce conflit avant de publier.');
    await rm(working, { recursive: true, force: true });
    await cp(destination, working, { recursive: true });
    session.revision = current.revision;
    await this.persist();
  }

  async publish(session) {
    if (session.publishing) return session.publishing;
    session.publishing = this.publishOnce(session).finally(() => { session.publishing = null; });
    return session.publishing;
  }

  async publishOnce(session) {
    if (session.mode === 'hub') throw new Error('Le menu ne peut pas publier ou remplacer une cartouche.');
    const source = path.join(session.workspace, 'cartridge');
    if (!await exists(path.join(source, 'game.js'))) {
      this.status(session, session.voice ? 'listening' : 'idle', 'En attente de ta demande.');
      return;
    }
    const inspection = await inspectCartridge({ directory: source, expectedId: session.gameId });
    if (inspection.revision === session.revision) {
      this.status(session, session.voice ? 'listening' : 'ready', 'Jeu à jour.');
      return;
    }
    const result = inspection;
    const destination = path.join(this.root, 'cartridges', session.gameId);
    if (session.published) {
      const current = await inspectCartridge({ directory: destination, expectedId: session.gameId });
      if (current.revision !== session.revision) throw new Error('Le jeu enregistré a changé pendant la préparation. Aucun changement externe n’a été écrasé.');
    }
    const candidate = path.join(this.root, 'cartridges', `.pending-${session.id}`);
    const previous = path.join(this.root, 'cartridges', `.replacing-${session.id}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(candidate, { recursive: true, force: true });
    await cp(source, candidate, { recursive: true, dereference: false });
    // Recheck the exact copied files before changing the only published cartouche.
    const copied = await inspectCartridge({ directory: candidate, expectedId: session.gameId });
    if (copied.revision !== result.revision) { await rm(candidate, { recursive: true, force: true }); throw new Error('Les fichiers ont changé pendant la validation. Réessaie après la fin de la modification.'); }
    this.status(session, 'applying', 'Enregistrement et application de la modification…');
    const hadPrevious = await exists(destination);
    if (hadPrevious && !session.published) throw new Error('Création refusée : cet identifiant existe déjà. Aucun jeu n’a été remplacé.');
    if (hadPrevious) await rename(destination, previous);
    try { await rename(candidate, destination); }
    catch (error) { if (hadPrevious) await rename(previous, destination); throw error; }
    await rm(previous, { recursive: true, force: true });
    session.revision = result.revision;
    session.published = true;
    session.repairing = 0;
    await this.persist();
    const event = { type: 'game-updated', gameId: session.gameId, revision: result.revision, requiresRestart: result.manifest.liveUpdate === 'restart', sessionId: session.id };
    this.send(session, event);
    this.emit('game-updated', event);
    this.emit('global', event);
    this.status(session, 'ready', event.requiresRestart ? 'Modification enregistrée. Le jeu proposera un redémarrage.' : 'Modification enregistrée et disponible dans le jeu.');
    // Release the live update before any browser work. Serialize checks for a
    // game and skip superseded revisions; no extra cartridge copies/history.
    session.verification = (session.verification ?? Promise.resolve())
      .then(() => this.verifyPublished(session, result.revision))
      .catch(error => this.emit('diagnostic', publicError(error)));
  }

  async handleNotification({ method, params: p = {} }) {
    const session = [...this.sessions.values()].find(s => s.threadId === p.threadId);
    if (!session) return;
    if (method === 'thread/realtime/sdp') session.resolveVoice?.(p.sdp);
    if (method === 'thread/realtime/error') {
      session.rejectVoice?.(new Error(p.message ?? p.error?.message ?? 'Erreur Realtime.'));
      session.voice = false;
      this.send(session, { type: 'voice-closed' });
      this.status(session, 'error', publicError(p.message ?? p.error ?? 'Erreur vocale Codex.'));
    }
    if (method === 'thread/realtime/closed') {
      const unexpected = !session.voiceStopping && Boolean(session.voice || session.rejectVoice);
      const message = `Connexion vocale fermée${p.reason ? ` : ${publicError(p.reason)}` : '.'}`;
      session.rejectVoice?.(new Error(message));
      session.voice = false;
      this.send(session, { type: 'voice-closed' });
      if (unexpected) this.status(session, 'error', message);
    }
    // CLI 0.153.1 emits canonical realtime timeline items as well as older flat
    // transcripts. Preserve roles from item/started for subsequent item deltas.
    if (method === 'thread/realtime/item/started' || method === 'thread/realtime/item/completed') {
      const item = p.item;
      if (item?.type === 'realtimeSessionStarted' && !session.hasTurns) {
        session.hasTurns = true;
        await this.persist();
      }
      if (item?.type === 'transcriptSegment' && ['user', 'assistant'].includes(item.role)) {
        session.canonicalTranscripts = true;
        if (!session.hasTurns) { session.hasTurns = true; await this.persist(); }
        const done = method.endsWith('/completed');
        const prior = session.realtimeItems.get(item.id);
        // A duplicated native notification must not duplicate a spoken segment.
        if (done && prior?.done) return;
        session.realtimeItems.set(item.id, { role: item.role, text: item.text ?? '', done });
        while (session.realtimeItems.size > 64) session.realtimeItems.delete(session.realtimeItems.keys().next().value);
        if (done || item.text) this.send(session, { type: 'transcript', role: item.role, text: item.text ?? '', itemId: item.id, done });
      }
    }
    if (method === 'thread/realtime/item/transcript/delta') {
      const item = session.realtimeItems.get(p.itemId);
      if (item && !item.done && typeof p.delta === 'string') {
        item.text += p.delta;
        this.send(session, { type: 'transcript', role: item.role, text: item.text, delta: p.delta, itemId: p.itemId, done: false });
      }
    }
    if (method.startsWith('thread/realtime/transcript/') && !session.canonicalTranscripts) {
      if (!session.hasTurns) { session.hasTurns = true; await this.persist(); }
      this.send(session, { type: 'transcript', role: p.role, text: p.text ?? p.delta ?? '', delta: p.delta, done: method.endsWith('/done') });
    }
    if (method === 'turn/started') { session.hasTurns = true; session.turnId = p.turn.id; await this.persist(); this.status(session, 'thinking', 'Codex examine la demande…'); }
    if (method === 'item/started' && ['commandExecution', 'fileChange'].includes(p.item?.type)) this.status(session, 'building', 'Codex travaille sur la cartouche…');
    if (method === 'item/completed' && p.item?.type === 'agentMessage') this.send(session, { type: 'message', role: 'assistant', text: p.item.text });
    if (method === 'turn/completed') {
      session.turnId = null;
      if (p.turn.status !== 'completed') { this.status(session, p.turn.status === 'interrupted' ? 'idle' : 'error', p.turn.error?.message ?? 'Modification interrompue ; le jeu enregistré est conservé.'); return; }
      if (session.mode === 'hub') { this.status(session, session.voice ? 'listening' : 'idle', 'Atelier prêt.'); return; }
      try { await this.publish(session); }
      catch (error) {
        this.status(session, 'error', `Jeu enregistré conservé : ${publicError(error)}`);
        // One bounded repair, in the SAME thread, and only with a real validation report.
        if (error.report && session.repairing < 1) {
          session.repairing += 1;
          await this.bridge.request('turn/start', { threadId: session.threadId, input: [{ type: 'text', text: `La validation réelle a échoué. Corrige uniquement les problèmes signalés, sans supprimer les fonctions demandées. Ne publie pas. Rapport : ${JSON.stringify(error.report).slice(0, 20_000)}` }], sandboxPolicy: this.policy(session), approvalPolicy: 'never' });
        }
      }
    }
  }

  async handleRequest({ id, method, params: p = {} }) {
    const session = [...this.sessions.values()].find(s => s.threadId === p.threadId);
    if (method === 'item/tool/call' && session) {
      try {
        if (session.mode === 'hub') {
          const key = p.callId ?? `${p.turnId ?? ''}:${id}`;
          if (!session.hubCalls.has(key)) {
            // A repeated RPC response must not create a second game.
            const call = Promise.resolve().then(() => routeHubTool(this, session, p.tool,
              typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments ?? {}));
            session.hubCalls.set(key, call);
          }
          const result = await session.hubCalls.get(key);
          if (session.hubCalls.size > 64) session.hubCalls.delete(session.hubCalls.keys().next().value);
          const contentItems = [textItem(JSON.stringify(result))];
          if (p.tool === 'capture_game' && result.fresh && session.screenshot) contentItems.push({ type: 'inputImage', imageUrl: session.screenshot });
          return this.bridge.respond(id, { success: result.state !== 'error', contentItems });
        }
        if (p.tool === 'capture_game') {
          const fresh = await this.requestCapture(session);
          const contentItems = [textItem(JSON.stringify({ fresh, ...session.context }))];
          if (session.screenshot) contentItems.push({ type: 'inputImage', imageUrl: session.screenshot });
          return this.bridge.respond(id, { success: Boolean(session.context), contentItems });
        }
        if (p.tool === 'validate_game') {
          const result = await this.validate(session);
          const report = structuredClone(result.report);
          if (report.browser) delete report.browser.screenshot;
          return this.bridge.respond(id, { success: true, contentItems: [textItem(JSON.stringify(report))] });
        }
        throw new Error('Outil non autorisé dans cet atelier.');
      } catch (error) { return this.bridge.respond(id, { success: false, contentItems: [textItem(JSON.stringify(error.report ?? { error: publicError(error) }))] }); }
    }
    // Never forward account credentials or silently approve unrelated requests.
    if (method === 'item/permissions/requestApproval') return this.bridge.respond(id, { permissions: {}, scope: 'turn' });
    if (method.includes('requestApproval')) return this.bridge.respond(id, { decision: 'decline' });
    this.bridge.respondError(id, -32601, 'Action non disponible dans cet atelier.');
    if (session) this.status(session, 'error', 'Codex demande une action non disponible dans cet atelier.');
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.sessions.values()].map(s => s.verification));
    await Promise.allSettled([...this.sessions.values()].filter(s => s.voice).map(s => this.stopVoice(s)));
    await this.persist();
    await this.bridge.close();
  }
}
