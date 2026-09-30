import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export const HUB_INSTRUCTIONS = `# Codex de la borne — une conversation, tous les jeux
Tu échanges en français, brièvement. Tu es le même interlocuteur dans le menu et pendant tous les jeux.
Tu peux créer et modifier n'importe quel jeu depuis n'importe quel écran. Le contexte décrit ce que voit le visiteur, pas une limite de tes capacités. Ne lui demande jamais de revenir au menu pour créer ou modifier.
Pour exécuter sa demande, utilise les outils du harness, qui enregistrent les changements dans la bonne cartouche :
- create_game(request) pour CHAQUE demande explicite de nouveau jeu, même dans le même appel vocal, même après un jeu terminé. Transmets le brief complet. Cela crée un nouvel identifiant et un nouveau thread de cartouche.
- edit_game(gameId, request) seulement pour une modification demandée d'un jeu existant. « Remets comme avant » reprend le même jeu et son thread. Ne transforme jamais une création en remplacement.
- list_games() pour identifier un jeu sans deviner son identifiant. « Ce jeu » désigne le jeu affiché dans le contexte ; un jeu nommé explicitement prime sur celui affiché. « Le précédent » ou « remets comme avant » s'interprète avec la conversation et le dernier travail. Pose une question seulement si plusieurs cibles restent plausibles.
- game_status(gameId) pour suivre un travail existant. Une attente ou une question de suivi ne crée jamais un deuxième jeu.
- capture_game(gameId?) pour voir une capture fraîche du jeu à l'écran et son état. Sans identifiant, utilise le jeu actuellement affiché. Ce n'est pas une vidéo continue ; un jeu fermé n'a pas de capture vivante.
Les outils de création/modification attendent le résultat réel du harness. Si le délai expire, le travail continue : utilise game_status, ne relance pas create_game.
Pose une question courte si création et modification sont réellement ambiguës. Annonce uniquement le résultat retourné par les outils. Chaque jeu garde sa DA, ses contrôles arcade et sa conversation. La voix reste ouverte pendant le travail.`;

const requestSchema = { type: 'string', minLength: 1, maxLength: 16000 };
const gameIdSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' };
const tool = (name, description, properties = {}, required = []) => ({ type: 'function', name, description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false } });
export const HUB_TOOLS = [
  tool('create_game', 'Crée un NOUVEAU jeu indépendant. Ne remplace jamais un jeu. Attend sa publication réelle.', { request: requestSchema }, ['request']),
  tool('edit_game', 'Transmet une modification au thread du jeu explicitement ciblé. Ne pas utiliser pour créer un autre jeu.', { gameId: gameIdSchema, request: requestSchema }, ['gameId', 'request']),
  tool('list_games', 'Liste les jeux publiés et leurs identifiants.'),
  tool('game_status', 'Lit le travail actuel d’un jeu sans lancer de génération.', { gameId: gameIdSchema }, ['gameId']),
  tool('capture_game', 'Demande une capture fraîche du jeu affiché et son état, quel que soit le contexte de conversation.', { gameId: gameIdSchema }),
];

export async function listGames(root) {
  const games = [];
  for (const entry of await readdir(path.join(root, 'cartridges'), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.name)) continue;
    try {
      const { id, title, description, maxPlayers } = JSON.parse(await readFile(path.join(root, 'cartridges', entry.name, 'game.json'), 'utf8'));
      if (id === entry.name) games.push({ id, title, description, maxPlayers });
    } catch { /* An incomplete directory is not a published cartridge. */ }
  }
  return games;
}

export function gameStatus(workshop, gameId) {
  const session = [...workshop.sessions.values()].find(s => s.mode !== 'hub' && s.gameId === gameId);
  if (!session) throw new Error('Aucune conversation pour ce jeu.');
  return { ...workshop.describe(session), state: session.state, message: session.message, revision: session.revision };
}

// Listen before submitting, never complete from a replayed SSE status. This is
// a bounded tool call, not a second worker, browser, or revision history.
export async function requestGame(workshop, session, request, timeoutMs = 600_000) {
  let finish, timer;
  const done = new Promise(resolve => { finish = resolve; });
  const listener = event => {
    if (event.type === 'game-updated') finish({ ...gameStatus(workshop, session.gameId), state: 'published', revision: event.revision });
    if (event.type === 'status' && ['ready', 'idle', 'error'].includes(event.state)) finish(gameStatus(workshop, session.gameId));
  };
  workshop.on(`session:${session.id}`, listener);
  try {
    timer = setTimeout(() => finish({ ...gameStatus(workshop, session.gameId), pending: true }), timeoutMs);
    await workshop.message(session, { text: request });
    return await done;
  } finally {
    clearTimeout(timer);
    workshop.off(`session:${session.id}`, listener);
  }
}

export async function routeHubTool(workshop, hub, name, args) {
  const spec = HUB_TOOLS.find(tool => tool.name === name)?.inputSchema;
  if (!spec) throw new Error('Outil inconnu.');
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !Object.hasOwn(spec.properties, key))
    || spec.required.some(key => !Object.hasOwn(args, key))) throw new Error('Arguments invalides.');
  if (Object.hasOwn(args, 'gameId') && (typeof args.gameId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.gameId))) throw new Error('Identifiant de jeu invalide.');
  if (Object.hasOwn(args, 'request') && (typeof args.request !== 'string' || !args.request.trim() || args.request.length > 16000)) throw new Error('Demande invalide.');
  if (name === 'list_games') return { games: await listGames(workshop.root) };
  if (name === 'game_status') return gameStatus(workshop, args.gameId);
  if (name === 'capture_game') {
    const gameId = args.gameId ?? hub.context?.gameId;
    if (!gameId) return { fresh: false, message: 'Le visiteur est dans le menu ; aucun jeu en cours.', context: hub.context };
    const fresh = await workshop.requestCapture(hub, 3000, gameId);
    return { fresh, context: fresh ? hub.context : null, message: fresh ? 'Capture actuelle.' : 'Ce jeu n’est pas affiché ou la borne n’a pas répondu.' };
  }
  // createSession(undefined) is intentionally never resolved through the hub's
  // id, selected game, or last completed cartridge.
  const result = await workshop.session(name === 'create_game' ? {} : { gameId: args.gameId });
  hub.lastGameId = result.gameId;
  await workshop.persist();
  const target = workshop.get(result.sessionId);
  // Editing the displayed game carries the visitor's live state/image. A
  // different named game gets its own capture request, never this game's image.
  if (name === 'edit_game' && hub.context?.gameId === result.gameId) {
    await workshop.updateContext(target, { ...hub.context, screenshot: hub.screenshot });
  }
  return requestGame(workshop, target, args.request);
}
