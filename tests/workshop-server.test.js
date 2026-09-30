import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Workshop } from '../server/workshop.js';
import { createArcadeServer } from '../server/index.js';
import { inspectCartridge } from '../server/validate-cartridge.js';
import { HUB_TOOLS, routeHubTool, requestGame } from '../server/hub-router.js';

let bridgeCount = 0;
class MockBridge extends EventEmitter {
  constructor() { super(); this.instance = ++bridgeCount; this.requests = []; this.responses = []; this.counter = 0; this.connected = false; }
  async connect() { this.connected = true; return {}; }
  async request(method, params) {
    this.requests.push({ method, params });
    this.emit('client-request', { method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
    if (method === 'thread/start') return { thread: { id: `mock-thread-${this.instance}-${++this.counter}` } };
    if (method === 'thread/resume') {
      if (this.resumeError) throw this.resumeError;
      return { thread: { id: params.threadId } };
    }
    if (method === 'turn/start') return { turn: { id: `mock-turn-${this.counter}` } };
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  respondError(id, code, message) { this.responses.push({ id, error: { code, message } }); }
  close() { this.connected = false; }
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=';
const firstCode = 'export default function createGame() { return { name: "original" }; }\n';
const secondCode = 'export default function createGame() { return { name: "modified" }; }\n';

async function fixture(t, { validator = inspectCartridge } = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'arcade-workshop-test-'));
  const bridge = new MockBridge();
  for (const directory of ['prompts', 'docs', 'cartridges/pong', 'src', 'assets']) await mkdir(path.join(root, directory), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, 'prompts/cartridge-maker.md'), 'Create only cartridge files. Preserve current play state when possible.'),
    writeFile(path.join(root, 'prompts/robot-voice.md'), 'Talk about the arcade game.'),
    writeFile(path.join(root, 'docs/CARTRIDGE_CONTRACT.md'), 'A fixture contract.'),
    writeFile(path.join(root, 'cartridges/pong/game.json'), JSON.stringify({ id: 'pong', title: 'Pong', maxPlayers: 2, entry: 'game.js' })),
    writeFile(path.join(root, 'cartridges/pong/config.json'), JSON.stringify({ speed: 100 })),
    writeFile(path.join(root, 'cartridges/pong/game.js'), firstCode),
    writeFile(path.join(root, 'moon.html'), '<!doctype html><title>Arcade fixture</title>'),
    writeFile(path.join(root, 'src/visible.js'), 'export const visible = true;'),
  ]);
  const workshop = new Workshop({ root, origin: 'http://127.0.0.1:8080', bridge, validator });
  await workshop.initialize();
  const value = { root, workshop, bridge, server: null };
  t.after(async () => {
    if (value.server) {
      value.server.closeAllConnections();
      await new Promise((resolve) => value.server.close(resolve));
    }
    await workshop.close();
    await rm(root, { recursive: true, force: true });
  });
  return value;
}

async function existingSession(value) {
  const result = await value.workshop.session({ gameId: 'pong', context: { gameId: 'pong', state: { score: 2 }, screenshot: PNG } });
  return value.workshop.get(result.sessionId);
}

test('one assistant follows menu/game context without changing its conversation or losing cartridge threads', async t => {
  const value = await fixture(t);
  const old = await existingSession(value);
  const result = await value.workshop.session({ sessionId: old.id, context: { mode: 'hub', selectedGameId: 'pong' } });
  const hub = value.workshop.get(result.sessionId);
  assert.notEqual(hub.id, old.id);
  assert.equal(hub.gameId, null);
  assert.equal(hub.mode, 'hub');
  assert.deepEqual(value.workshop.policy(hub), { type: 'readOnly' });
  const started = value.bridge.requests.find(r => r.method === 'thread/start' && r.params.cwd === hub.workspace).params;
  assert.equal(started.sandbox, 'read-only');
  assert.deepEqual(started.dynamicTools, HUB_TOOLS);
  assert.deepEqual((await readdir(hub.workspace)).sort(), ['AGENTS.md', 'reference']);
  await assert.rejects(value.workshop.publish(hub), /menu ne peut pas publier/);
  await assert.rejects(value.workshop.validate(hub), /menu ne possède pas/);
  const playing = await value.workshop.session({ mode: 'assistant', context: { mode: 'game', gameId: 'pong', state: { score: 42 }, screenshot: PNG } });
  assert.equal(playing.sessionId, hub.id);
  assert.equal(playing.threadId, hub.threadId);
  assert.equal(hub.context.gameId, 'pong');
  assert.equal(hub.context.state.score, 42);
  assert.equal(hub.screenshot, PNG);
  const worker = await value.workshop.session({ gameId: 'pong' });
  assert.equal(worker.threadId, old.threadId, 'per-game edit history remains available internally');
  await value.workshop.handleNotification({ method: 'turn/completed', params: { threadId: hub.threadId, turn: { status: 'completed' } } });
  assert.deepEqual(await readdir(path.join(value.root, 'cartridges')), ['pong']);
  const resumed = await value.workshop.session({ sessionId: hub.id, context: { mode: 'hub' } });
  assert.equal(resumed.threadId, hub.threadId);
  const bridge = new MockBridge();
  const restarted = new Workshop({ root: value.root, origin: value.workshop.origin, bridge });
  await restarted.initialize();
  assert.equal(restarted.get(hub.id).mode, 'hub');
  assert.equal(restarted.get(hub.id).gameId, null);
  await restarted.close();
});

test('assistant captures the actual game from its current context without opening another conversation', async t => {
  const value = await fixture(t);
  const hub = value.workshop.get((await value.workshop.session({ mode: 'assistant', context: { mode: 'game', gameId: 'pong' } })).sessionId);
  value.workshop.on(`session:${hub.id}`, event => {
    if (event.type !== 'capture-request') return;
    assert.equal(event.gameId, 'pong');
    value.workshop.updateContext(hub, { mode: 'game', gameId: 'pong', state: { score: 9 }, screenshot: PNG }, event.requestId);
  });
  await value.workshop.handleRequest({ id: 'view', method: 'item/tool/call', params: { threadId: hub.threadId, tool: 'capture_game', arguments: {} } });
  const response = value.bridge.responses.at(-1).result;
  const result = JSON.parse(response.contentItems[0].text);
  assert.equal(result.fresh, true);
  assert.equal(result.context.state.score, 9);
  assert.deepEqual(response.contentItems[1], { type: 'inputImage', imageUrl: PNG });
  assert.equal(value.workshop.sessions.size, 1);
});

test('two creations in one hub conversation preserve every old game; corrections keep the target thread', async t => {
  const value = await fixture(t);
  const hub = value.workshop.get((await value.workshop.session({ mode: 'hub' })).sessionId);
  const jobs = [];
  // Deterministic simulated cartridge worker, not a real Codex/gameplay test.
  value.bridge.on('client-request', event => {
    if (event.method !== 'turn/start') return;
    const session = [...value.workshop.sessions.values()].find(s => s.threadId === event.params.threadId);
    jobs.push((async () => {
      await value.workshop.handleNotification({ method: 'turn/started', params: { threadId: session.threadId, turn: { id: `turn-${jobs.length}` } } });
      await writeFile(path.join(session.workspace, 'cartridge/game.js'), secondCode);
      await value.workshop.handleNotification({ method: 'turn/completed', params: { threadId: session.threadId, turn: { status: 'completed' } } });
    })());
  });
  const first = await routeHubTool(value.workshop, hub, 'create_game', { request: 'Un jeu de course' });
  await Promise.all(jobs);
  const firstBytes = await readFile(path.join(value.root, 'cartridges', first.gameId, 'game.js'), 'utf8');
  await value.workshop.updateContext(hub, { mode: 'game', gameId: first.gameId, state: { score: 42 } });
  const call = { method: 'item/tool/call', params: { threadId: hub.threadId, callId: 'second-creation', tool: 'create_game', arguments: JSON.stringify({ request: 'Maintenant un NOUVEAU jeu d’équilibre' }) } };
  await Promise.all([value.workshop.handleRequest({ ...call, id: 30 }), value.workshop.handleRequest({ ...call, id: 31 })]);
  await Promise.all(jobs);
  const second = JSON.parse(value.bridge.responses.find(r => r.id === 30).result.contentItems[0].text);
  assert.notEqual(second.gameId, first.gameId);
  assert.notEqual(second.threadId, first.threadId);
  assert.equal(first.state, 'published');
  assert.equal(second.state, 'published');
  assert.equal((await readdir(path.join(value.root, 'cartridges'))).length, 3);
  assert.equal(jobs.length, 2, 'replayed tool RPC creates no duplicate');
  assert.equal(await readFile(path.join(value.root, 'cartridges/pong/game.js'), 'utf8'), firstCode);
  assert.equal(await readFile(path.join(value.root, 'cartridges', first.gameId, 'game.js'), 'utf8'), firstBytes);
  // While looking at Second, an explicit edit of First still targets First.
  await value.workshop.updateContext(hub, { mode: 'game', gameId: second.gameId });
  const edit = await routeHubTool(value.workshop, hub, 'edit_game', { gameId: first.gameId, request: 'Remets comme avant' });
  await Promise.all(jobs);
  assert.equal(edit.sessionId, first.sessionId);
  assert.equal(edit.threadId, first.threadId);
  assert.equal((await readdir(path.join(value.root, 'cartridges'))).length, 3);
  assert.equal(hub.lastGameId, first.gameId);
});

test('concurrent new requests get distinct workspaces and a creation refuses any existing destination', async t => {
  const value = await fixture(t);
  const [one, two] = await Promise.all([value.workshop.session(), value.workshop.session()]);
  assert.notEqual(one.gameId, two.gameId);
  assert.notEqual(one.threadId, two.threadId);
  const session = value.workshop.get(one.sessionId);
  await writeFile(path.join(session.workspace, 'cartridge/game.js'), secondCode);
  const destination = path.join(value.root, 'cartridges', one.gameId);
  await mkdir(destination);
  await writeFile(path.join(destination, 'game.js'), firstCode);
  await assert.rejects(value.workshop.publish(session), /identifiant existe déjà/);
  assert.equal(await readFile(path.join(destination, 'game.js'), 'utf8'), firstCode);
});

test('hub rejects malformed targeting and a timed-out job is followable without another generation', async t => {
  const value = await fixture(t);
  const hub = value.workshop.get((await value.workshop.session({ mode: 'hub' })).sessionId);
  for (const [tool, args] of [
    ['create_game', { request: 'new', gameId: 'pong' }],
    ['edit_game', { request: 'change' }],
    ['edit_game', { request: 'change', gameId: '../pong' }],
    ['create_game', { request: '' }],
    ['validate_game', {}],
  ]) await assert.rejects(routeHubTool(value.workshop, hub, tool, args));
  assert.equal(value.workshop.sessions.size, 1);
  const session = value.workshop.get((await value.workshop.session()).sessionId);
  const waiting = await requestGame(value.workshop, session, 'work', 5);
  assert.equal(waiting.pending, true);
  assert.equal(value.workshop.listenerCount(`session:${session.id}`), 0);
  const calls = value.bridge.requests.length;
  const status = await routeHubTool(value.workshop, hub, 'game_status', { gameId: session.gameId });
  assert.equal(status.gameId, session.gameId);
  assert.equal(value.bridge.requests.length, calls);
});

test('workshop keeps the same thread for edits and confines every turn to the cartridge workspace', async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  const resumed = await value.workshop.session({ sessionId: session.id, gameId: 'pong' });
  assert.equal(resumed.threadId, session.threadId);
  await value.workshop.message(session, { text: 'Slow the ball.' });
  session.turnId = 'active-turn';
  await value.workshop.message(session, { text: 'No, put it back.' });
  assert.equal(value.bridge.requests.filter((request) => request.method === 'thread/start').length, 1);
  const start = value.bridge.requests.find((request) => request.method === 'thread/start').params;
  assert.deepEqual(start.runtimeWorkspaceRoots, [session.workspace]);
  assert.equal(start.approvalPolicy, 'never');
  assert.equal(start.config['sandbox_workspace_write.network_access'], false);
  assert.deepEqual(start.dynamicTools.map((tool) => tool.name), ['capture_game', 'validate_game']);
  const turn = value.bridge.requests.find((request) => request.method === 'turn/start').params;
  assert.equal(turn.threadId, session.threadId);
  assert.deepEqual(turn.sandboxPolicy.writableRoots, [session.workspace]);
  assert.equal(turn.sandboxPolicy.excludeSlashTmp, true);
  assert.equal(turn.sandboxPolicy.networkAccess, false);
  assert.deepEqual(turn.input[1], { type: 'localImage', path: path.join(session.workspace, 'reference/current-screen.png') });
  const steer = value.bridge.requests.find((request) => request.method === 'turn/steer').params;
  assert.equal(steer.threadId, session.threadId);
  assert.equal(steer.expectedTurnId, 'active-turn');
  assert.match(steer.input[0].text, /put it back/);
});

test('workshop rejects other-game context and returns fresh game-only captures through the declared tool', async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  await assert.rejects(value.workshop.updateContext(session, { gameId: 'another-game' }), /correspond pas/);
  await assert.rejects(value.workshop.updateContext(session, { gameId: 'pong', state: 'x'.repeat(150_001) }), /volumineux/);
  value.workshop.on(`session:${session.id}`, (event) => {
    if (event.type === 'capture-request') value.workshop.updateContext(session, { gameId: 'pong', state: { score: 3 }, screenshot: PNG }, event.requestId);
  });
  await value.workshop.handleRequest({ id: 'capture-call', method: 'item/tool/call', params: { threadId: session.threadId, tool: 'capture_game' } });
  const result = value.bridge.responses.at(-1).result;
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(result.contentItems[0].text).state, { score: 3 });
  assert.equal(JSON.parse(result.contentItems[0].text).fresh, true);
  assert.deepEqual(result.contentItems[1], { type: 'inputImage', imageUrl: PNG });
  assert.equal(session.captures.size, 0);
});

test('Astra high Fast is the default and explicit overrides apply only to the requested turn', async t => {
  const value = await fixture(t);
  const session = await existingSession(value);
  const context = { gameId: 'pong' };
  await value.workshop.message(session, { text: 'Make the background teal.', context, model: 'gpt-5.6-sol', effort: 'low' });
  const turn = value.bridge.requests.filter(r => r.method === 'turn/start').at(-1).params;
  assert.equal(turn.model, 'gpt-5.6-sol');
  assert.equal(turn.effort, 'low');
  assert.equal(turn.serviceTier, 'priority');
  assert.equal(turn.threadId, session.threadId);
  await assert.rejects(value.workshop.message(session, { text: 'Change it.', effort: 'invalid' }), /Effort/);
  session.turnId = 'active-turn';
  await assert.rejects(value.workshop.message(session, { text: 'Change it.', effort: 'low' }), /Attends/);
  session.turnId = null;
  await value.workshop.message(session, { text: 'Keep it.', context });
  const ordinary = value.bridge.requests.filter(r => r.method === 'turn/start').at(-1).params;
  assert.equal(ordinary.model, 'gpt-6-astra');
  assert.equal(ordinary.effort, 'high');
  assert.equal(ordinary.serviceTier, 'priority');
  session.turnId = 'active-turn';
  await value.workshop.message(session, { text: 'Also keep the ball.', context });
  assert.equal(value.bridge.requests.at(-1).method, 'turn/steer');
  assert.equal(Object.hasOwn(value.bridge.requests.at(-1).params, 'model'), false);
});

test('new and resumed hub/cartridge threads receive Astra high Fast before any delegated work', async t => {
  const value = await fixture(t);
  const game = await existingSession(value);
  const hub = value.workshop.get((await value.workshop.session({ mode: 'assistant' })).sessionId);
  for (const session of [game, hub]) {
    const start = value.bridge.requests.find(r => r.method === 'thread/start' && r.params.cwd === session.workspace).params;
    assert.equal(start.model, 'gpt-6-astra');
    assert.equal(start.serviceTier, 'priority');
    assert.equal(start.config.model_reasoning_effort, 'high');
    session.loaded = false;
    await value.workshop.load(session);
    const resume = value.bridge.requests.filter(r => r.method === 'thread/resume').at(-1).params;
    assert.equal(resume.threadId, session.threadId);
    assert.equal(resume.model, 'gpt-6-astra');
    assert.equal(resume.serviceTier, 'priority');
    assert.equal(resume.config.model_reasoning_effort, 'high');
    const settings = value.bridge.requests.at(-1);
    assert.equal(settings.method, 'thread/settings/update');
    assert.equal(settings.params.model, 'gpt-6-astra');
    assert.equal(settings.params.effort, 'high');
    assert.equal(settings.params.serviceTier, 'priority');
  }
});

test('publication atomically replaces the one saved game and emits its new revision without accumulating history', async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  await writeFile(path.join(session.workspace, 'cartridge/game.js'), secondCode);
  const events = [];
  value.workshop.on('game-updated', (event) => events.push(event));
  await value.workshop.publish(session);
  assert.equal(await readFile(path.join(value.root, 'cartridges/pong/game.js'), 'utf8'), secondCode);
  assert.deepEqual(await readdir(path.join(value.root, 'cartridges')), ['pong']);
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, session.id);
  assert.equal(events[0].revision, session.revision);
  assert.equal(session.state, 'ready');
  await value.workshop.publish(session);
  assert.equal(events.length, 1);
});

test('failed static compilation preserves the saved game and does not publish tentative files', async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  await writeFile(path.join(session.workspace, 'cartridge/game.js'), 'export default () => { broken syntax };');
  const revision = session.revision;
  await assert.rejects(value.workshop.publish(session), /Compilation|JavaScript invalide/);
  assert.equal(await readFile(path.join(value.root, 'cartridges/pong/game.js'), 'utf8'), firstCode);
  assert.equal(session.revision, revision);
  assert.deepEqual(await readdir(path.join(value.root, 'cartridges')), ['pong']);
});

test('publication reaches the player before the browser finishes; its thumbnail never reloads gameplay', async t => {
  let finishBrowser, entered;
  const browserStarted = new Promise(resolve => { entered = resolve; });
  const browser = new Promise(resolve => { finishBrowser = resolve; });
  const value = await fixture(t, { validator: async args => {
    entered(args);
    await browser;
    const result = await inspectCartridge(args);
    return { ...result, report: { ...result.report, browser: { screenshot: PNG } } };
  } });
  const session = await existingSession(value);
  const updates = [], thumbnails = [];
  value.workshop.on('game-updated', event => updates.push(event));
  value.workshop.on('global', event => { if (event.type === 'game-thumbnail-updated') thumbnails.push(event); });
  try {
    await writeFile(path.join(session.workspace, 'cartridge/game.js'), secondCode);
    await value.workshop.publish(session);
    const args = await browserStarted;
    assert.equal(args.directory, path.join(value.root, 'cartridges/pong'));
    assert.match(args.previewUrl, /\?game=pong$/);
    assert.equal(await readFile(path.join(args.directory, 'game.js'), 'utf8'), secondCode);
    assert.equal(updates.length, 1, 'the browser promise is still unresolved');
    assert.equal(session.state, 'ready');
    const revision = session.revision;
    finishBrowser();
    await session.verification;
    assert.equal(session.lastVerification.ok, true);
    assert.equal(session.revision, revision);
    assert.equal((await inspectCartridge(args)).revision, revision);
    assert.equal(updates.length, 1);
    assert.equal(thumbnails.length, 1);
    assert.equal(await value.workshop.getThumbnail('pong', revision), PNG);
    assert.equal(await value.workshop.getThumbnail('pong', 'old-revision'), null);
    value.workshop.thumbnails.clear();
    assert.equal(await value.workshop.getThumbnail('pong', revision), PNG, 'thumbnail survives harness restart');
    assert.deepEqual(await readdir(path.join(value.root, 'cartridges')), ['pong']);
    assert.deepEqual(await readdir(path.join(value.root, '.arcade/thumbnails')), ['pong.json']);
  } finally { finishBrowser(); await session.verification; }
});

test('background browser failure is reported after publication without reverting the saved game', async t => {
  const value = await fixture(t, { validator: async () => { throw Object.assign(new Error('Mock browser validation failed'), { report: { errors: ['A simulated missing control'] } }); } });
  const session = await existingSession(value);
  await writeFile(path.join(session.workspace, 'cartridge/game.js'), secondCode);
  await value.workshop.publish(session);
  await session.verification;
  assert.equal(await readFile(path.join(value.root, 'cartridges/pong/game.js'), 'utf8'), secondCode);
  assert.equal(session.state, 'error');
  assert.equal(session.lastVerification.ok, false);
  assert.match(session.message, /Modification publiée/);
  assert.equal((await value.workshop.conversationContext(session)).verification.ok, false);
});

test('obsolete browser failures cannot overwrite a newer edit or its thumbnail', async t => {
  let entered, failOld;
  const started = new Promise(resolve => { entered = resolve; });
  const failed = new Promise(resolve => { failOld = resolve; });
  let calls = 0;
  const value = await fixture(t, { validator: async args => {
    if (++calls === 1) { entered(); await failed; throw new Error('obsolete failure'); }
    const result = await inspectCartridge(args);
    return { ...result, report: { ...result.report, browser: { screenshot: PNG } } };
  } });
  const session = await existingSession(value);
  try {
    await writeFile(path.join(session.workspace, 'cartridge/game.js'), secondCode);
    await value.workshop.publish(session);
    await started;
    await writeFile(path.join(session.workspace, 'cartridge/config.json'), '{"speed":200}');
    await value.workshop.publish(session);
    const latest = session.revision;
    failOld();
    await session.verification;
    assert.equal(session.state, 'ready');
    assert.equal(session.lastVerification.revision, latest);
    assert.equal(session.lastVerification.ok, true);
    assert.equal(await value.workshop.getThumbnail('pong', latest), PNG);
  } finally { failOld(); await session.verification; }
});

test('an explicit successful browser check is reused instead of testing the same files twice', async t => {
  let calls = 0;
  const value = await fixture(t, { validator: async args => { calls++; return inspectCartridge(args); } });
  const session = await existingSession(value);
  await writeFile(path.join(session.workspace, 'cartridge/game.js'), secondCode);
  await value.workshop.validate(session);
  await value.workshop.publish(session);
  await session.verification;
  assert.equal(calls, 1);
  assert.equal(session.lastVerification.ok, true);
});

test('publication does not overwrite edits made outside the active thread', async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  await writeFile(path.join(session.workspace, 'cartridge/game.js'), secondCode);
  const external = 'export default () => ({ name: "external edit" });\n';
  await writeFile(path.join(value.root, 'cartridges/pong/game.js'), external);
  await assert.rejects(value.workshop.publish(session), /changé pendant la préparation/);
  assert.equal(await readFile(path.join(value.root, 'cartridges/pong/game.js'), 'utf8'), external);
  assert.equal(await readFile(path.join(session.workspace, 'cartridge/game.js'), 'utf8'), secondCode);
});

test('approval refusals obey their distinct protocol schemas and unknown tools are not executed', async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  await value.workshop.handleRequest({ id: 1, method: 'item/permissions/requestApproval', params: { threadId: session.threadId } });
  await value.workshop.handleRequest({ id: 2, method: 'item/commandExecution/requestApproval', params: { threadId: session.threadId } });
  await value.workshop.handleRequest({ id: 3, method: 'item/tool/call', params: { threadId: session.threadId, tool: 'not_allowed' } });
  await value.workshop.handleRequest({ id: 4, method: 'account/chatgptAuthTokens/refresh', params: {} });
  assert.deepEqual(value.bridge.responses[0], { id: 1, result: { permissions: {}, scope: 'turn' } });
  assert.deepEqual(value.bridge.responses[1], { id: 2, result: { decision: 'decline' } });
  assert.equal(value.bridge.responses[2].result.success, false);
  assert.equal(value.bridge.responses[3].error.code, -32601);
});

test('native realtime errors close the voice state and expose the error without manufacturing a fallback', async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  session.voice = true;
  const events = [];
  value.workshop.on(`session:${session.id}`, (event) => events.push(event));
  await value.workshop.handleNotification({ method: 'thread/realtime/error', params: { threadId: session.threadId, message: 'Native realtime unavailable' } });
  assert.equal(session.voice, false);
  assert.equal(events[0].type, 'voice-closed');
  assert.match(events.at(-1).message, /Native realtime unavailable/);
  assert.equal(session.state, 'error');
  assert.equal(value.bridge.requests.filter((request) => request.method.startsWith('turn/')).length, 0);
});

test('native voice uses protocol v3 and never mistakes SDP negotiation for confirmed microphone transport', { timeout: 5000 }, async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  const events = [];
  value.workshop.on(`session:${session.id}`, (event) => events.push(event));
  const submitted = new Promise((resolve) => {
    const listener = (request) => {
      if (request.method !== 'thread/realtime/start') return;
      value.bridge.off('client-request', listener);
      resolve(request.params);
    };
    value.bridge.on('client-request', listener);
  });
  const offer = 'v=0\r\no=mock-browser-offer';
  const answer = 'v=0\r\no=mock-native-answer';
  let settled = false;
  const pending = value.workshop.startVoice(session, { sdp: offer });
  pending.then(() => { settled = true; }, () => { settled = true; });
  t.after(() => session.rejectVoice?.(new Error('Test cleanup')));
  const params = await submitted;
  assert.equal(params.threadId, session.threadId);
  assert.equal(params.version, 'v3');
  assert.equal(params.outputModality, 'audio');
  assert.deepEqual(params.transport, { type: 'webrtc', sdp: offer });
  assert.equal(params.includeStartupContext, true);
  assert.equal(params.clientManagedHandoffs, false);
  assert.equal(params.flushTranscriptTailOnSessionEnd, false);
  assert.equal(Object.hasOwn(params, 'model'), false);
  const settings = value.bridge.requests.filter(r => r.method === 'thread/settings/update').at(-1).params;
  assert.equal(settings.model, 'gpt-6-astra');
  assert.equal(settings.effort, 'high');
  assert.equal(settings.serviceTier, 'priority');
  assert.equal(session.voice, false);
  assert.equal(session.state, 'connecting');
  await value.workshop.handleNotification({ method: 'thread/realtime/sdp', params: { threadId: 'different-thread', sdp: answer } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'The start RPC acknowledgement or another thread SDP must not imply a voice connection.');
  await value.workshop.handleNotification({ method: 'thread/realtime/sdp', params: { threadId: session.threadId, sdp: answer } });
  assert.deepEqual(await pending, { sdp: answer });
  assert.equal(session.voice, true);
  assert.equal(session.state, 'connecting');
  assert.equal(events.some(event => event.state === 'listening'), false);
  assert.equal(session.resolveVoice, null);
  assert.equal(session.rejectVoice, null);
  await value.workshop.stopVoice(session);
  assert.equal(session.voice, false);
  assert.equal(session.state, 'idle');
  assert.ok(events.some((event) => event.type === 'voice-closed'));
  assert.deepEqual(value.bridge.requests.at(-1), { method: 'thread/realtime/stop', params: { threadId: session.threadId } });
  assert.equal(value.bridge.requests.filter((request) => request.method.startsWith('turn/')).length, 0);
});

test('canonical v3 transcript items stream full text with the correct speaker without duplicated flat events', async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  const events = [];
  value.workshop.on(`session:${session.id}`, event => events.push(event));
  const notify = (method, params) => value.workshop.handleNotification({ method, params: { threadId: session.threadId, ...params } });
  const item = { id: 'speech-1', realtimeSessionId: 'native-call', type: 'transcriptSegment', role: 'user', text: '' };
  await notify('thread/realtime/item/started', { item });
  await notify('thread/realtime/item/transcript/delta', { itemId: item.id, delta: 'Fais ' });
  await notify('thread/realtime/transcript/delta', { role: 'user', delta: 'Fais ' });
  await notify('thread/realtime/item/transcript/delta', { itemId: item.id, delta: 'un jeu.' });
  await notify('thread/realtime/item/completed', { item: { ...item, text: 'Fais un jeu.' } });
  await notify('thread/realtime/transcript/done', { role: 'user', text: 'Fais un jeu.' });
  await notify('thread/realtime/item/completed', { item: { ...item, text: 'Fais un jeu.' } });
  await notify('thread/realtime/item/transcript/delta', { itemId: 'unknown-speech', delta: 'Ignore unknown role.' });
  const transcripts = events.filter(event => event.type === 'transcript');
  assert.equal(transcripts.length, 3);
  assert.deepEqual(transcripts.map(({ role, text, done }) => ({ role, text, done })), [
    { role: 'user', text: 'Fais ', done: false },
    { role: 'user', text: 'Fais un jeu.', done: false },
    { role: 'user', text: 'Fais un jeu.', done: true },
  ]);
  assert.equal(transcripts[1].delta, 'un jeu.');
  assert.equal(transcripts[1].itemId, item.id);
  const stored = JSON.parse(await readFile(path.join(value.root, '.arcade/sessions.json'), 'utf8'));
  assert.equal(stored.find(row => row.id === session.id).hasTurns, true);
  assert.equal(value.bridge.requests.filter(request => request.method.startsWith('turn/')).length, 0, 'Transcripts are feedback; only native delegation starts work.');
});

test('committed voice-only conversation is retained even when no coding turn was started', async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  await value.workshop.handleNotification({ method: 'thread/realtime/item/completed', params: {
    threadId: session.threadId,
    item: { id: 'voice-start', realtimeSessionId: 'native-call', type: 'realtimeSessionStarted' },
  } });
  const stored = JSON.parse(await readFile(path.join(value.root, '.arcade/sessions.json'), 'utf8'));
  assert.equal(stored.find(row => row.id === session.id).hasTurns, true);
  assert.equal(session.turnId, null);
});

test('native close during startup fails promptly and cannot remain on the listening screen', { timeout: 5000 }, async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  const submitted = new Promise(resolve => value.bridge.on('client-request', request => {
    if (request.method === 'thread/realtime/start') resolve();
  }));
  const pending = value.workshop.startVoice(session, { sdp: 'v=0\r\no=mock-browser-offer' });
  const rejected = assert.rejects(pending, /Connexion vocale fermée.*transport failed/);
  await submitted;
  await value.workshop.handleNotification({ method: 'thread/realtime/closed', params: { threadId: session.threadId, reason: 'transport failed' } });
  await rejected;
  assert.equal(session.voice, false);
  assert.equal(session.state, 'error');
  assert.equal(session.rejectVoice, null);
});

test('ending a pending call cancels startup without sending audio or starting a coding turn', { timeout: 5000 }, async (t) => {
  const value = await fixture(t);
  const session = await existingSession(value);
  const submitted = new Promise(resolve => value.bridge.on('client-request', request => {
    if (request.method === 'thread/realtime/start') resolve();
  }));
  const pending = value.workshop.startVoice(session, { sdp: 'v=0\r\no=mock-browser-offer' });
  const rejected = assert.rejects(pending, /annulée/);
  await submitted;
  await value.workshop.stopVoice(session);
  await rejected;
  await value.workshop.handleNotification({ method: 'thread/realtime/sdp', params: { threadId: session.threadId, sdp: 'v=0\r\no=late-answer' } });
  assert.equal(session.voice, false);
  assert.equal(session.state, 'idle');
  assert.equal(session.resolveVoice, null);
  assert.equal(value.bridge.requests.filter(request => request.method.startsWith('turn/')).length, 0);
});


test('after a server restart only an empty missing Codex thread can be recreated', async (t) => {
  const value = await fixture(t);
  const original = await existingSession(value);
  await value.workshop.persist();
  const bridge = new MockBridge();
  bridge.resumeError = new Error('no rollout found for empty thread');
  const restarted = new Workshop({ root: value.root, origin: value.workshop.origin, bridge, validator: inspectCartridge });
  try {
    await restarted.initialize();
    const result = await restarted.session({ sessionId: original.id, gameId: 'pong' });
    assert.equal(result.sessionId, original.id);
    assert.notEqual(result.threadId, original.threadId);
    assert.equal(bridge.requests.filter((request) => request.method === 'thread/resume').length, 1);
    assert.equal(bridge.requests.filter((request) => request.method === 'thread/start').length, 1);
  } finally { await restarted.close(); }
});

test('after a server restart a conversation with turns is resumed and never silently replaced', async (t) => {
  const value = await fixture(t);
  const original = await existingSession(value);
  await value.workshop.handleNotification({ method: 'turn/started', params: { threadId: original.threadId, turn: { id: 'existing-turn' } } });
  const stored = JSON.parse(await readFile(path.join(value.root, '.arcade/sessions.json'), 'utf8'));
  assert.equal(stored.find((item) => item.id === original.id).hasTurns, true);
  const bridge = new MockBridge();
  const restarted = new Workshop({ root: value.root, origin: value.workshop.origin, bridge, validator: inspectCartridge });
  try {
    await restarted.initialize();
    const result = await restarted.session({ sessionId: original.id, gameId: 'pong' });
    assert.equal(result.threadId, original.threadId);
    assert.equal(bridge.requests.filter((request) => request.method === 'thread/start').length, 0);
    const session = restarted.get(original.id);
    session.loaded = false;
    bridge.resumeError = new Error('no rollout found for non-empty conversation');
    await assert.rejects(restarted.session({ sessionId: original.id, gameId: 'pong' }), /no rollout found/);
    assert.equal(bridge.requests.filter((request) => request.method === 'thread/start').length, 0);
    assert.equal(session.threadId, original.threadId);
  } finally { await restarted.close(); }
});

async function serverFixture(t) {
  const value = await fixture(t);
  const app = await createArcadeServer({ root: value.root, port: 0, workshop: value.workshop });
  value.server = app.server;
  const address = await app.listen();
  value.origin = `http://127.0.0.1:${address.port}`;
  return value;
}

test('HTTP catalogue serves a generated thumbnail only for its matching game revision', async t => {
  const value = await serverFixture(t);
  const revision = (await inspectCartridge({ directory: path.join(value.root, 'cartridges/pong') })).revision;
  value.workshop.thumbnails.set('pong', { revision, screenshot: PNG });
  const { games } = await (await fetch(`${value.origin}/api/games`)).json();
  assert.equal(games[0].screenshot, '/api/games/pong/thumbnail');
  const image = await fetch(`${value.origin}${games[0].screenshot}?revision=${revision}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(PNG.split(',')[1], 'base64'));
  assert.equal((await fetch(`${value.origin}${games[0].screenshot}?revision=old`)).status, 404);
  assert.equal((await fetch(`${value.origin}/api/games/another-game/thumbnail?revision=${revision}`)).status, 404);
});

test('cartridge workspaces receive the MIDI authoring helper and the server serves MIDI as audio', async t => {
  const value = await serverFixture(t);
  const helper = await readFile(new URL('../src/midi.js', import.meta.url), 'utf8');
  await writeFile(path.join(value.root, 'src/midi.js'), helper);
  const session = await existingSession(value);
  assert.equal(await readFile(path.join(session.workspace, 'reference/midi.mjs'), 'utf8'), helper);
  const midi = await readFile(new URL('../assets/audio/music/petite-orbite.mid', import.meta.url));
  await writeFile(path.join(value.root, 'cartridges/pong/soundtrack.mid'), midi);
  const response = await fetch(`${value.origin}/cartridges/pong/soundtrack.mid`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/midi');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), midi);
});

test('HTTP routes refuse foreign origins, DNS rebinding hosts and private project files', async (t) => {
  const value = await serverFixture(t);
  for (const filename of ['/.arcade/sessions.json', '/.env', '/server/workshop.js', '/prompts/cartridge-maker.md', '/package.json', '/%2e%2e/private']) {
    const response = await fetch(value.origin + filename);
    assert.ok([403, 404].includes(response.status), `${filename} must stay private`);
  }
  assert.equal((await fetch(value.origin + '/api/workshop/state', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(value.origin + '/api/workshop/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const request = http.get(value.origin + '/api/workshop/state', { headers: { Host: 'attacker.example' } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(rebound, 403);
  assert.equal((await fetch(value.origin + '/src/visible.js')).status, 200);
  assert.equal((await fetch(value.origin + '/')).status, 200);
});

test('HTTP state/catalogue are read-only and a text request routes to the same session', async (t) => {
  const value = await serverFixture(t);
  const state = await (await fetch(value.origin + '/api/workshop/state')).json();
  const games = await (await fetch(value.origin + '/api/games')).json();
  assert.deepEqual(state.sessions, []);
  assert.equal(games.games[0].id, 'pong');
  assert.equal(value.bridge.requests.length, 0);
  const response = await fetch(value.origin + '/api/workshop/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameId: 'pong' }) });
  assert.equal(response.status, 200);
  const session = await response.json();
  const message = await fetch(`${value.origin}/api/workshop/${session.sessionId}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Make the ball yellow.', context: { gameId: 'pong', score: 4 } }) });
  assert.equal(message.status, 202);
  assert.equal(value.bridge.requests.find((request) => request.method === 'turn/start').params.threadId, session.threadId);
  assert.equal((await fetch(value.origin + '/api/workshop/session', { method: 'POST', body: '{}' })).status, 415);
});

test('static files cannot traverse an external symlink', async (t) => {
  const value = await serverFixture(t);
  const outside = await mkdtemp(path.join(await realpath(tmpdir()), 'arcade-external-test-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'private.json'), '{"private":true}');
  await symlink(path.join(outside, 'private.json'), path.join(value.root, 'src/escape.json'));
  assert.equal((await fetch(value.origin + '/src/escape.json')).status, 403);
});

test('static symlinks inside the project cannot expose private harness files', async (t) => {
  const value = await serverFixture(t);
  const privateFile = path.join(value.root, '.arcade/private-fixture.json');
  await writeFile(privateFile, '{"fixtureOnly":"private-harness-state"}');
  await symlink(privateFile, path.join(value.root, 'src/private-alias.json'));
  await symlink(path.join(value.root, '.arcade'), path.join(value.root, 'assets/private-alias'));
  for (const pathname of ['/src/private-alias.json', '/assets/private-alias/private-fixture.json']) {
    const response = await fetch(value.origin + pathname);
    assert.equal(response.status, 403, `${pathname} must be checked after resolving its target`);
    assert.doesNotMatch(await response.text(), /private-harness-state/);
  }
  await symlink(path.join(value.root, 'src/visible.js'), path.join(value.root, 'src/public-alias.js'));
  assert.equal((await fetch(value.origin + '/src/public-alias.js')).status, 200);
});
