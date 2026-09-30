import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkshopClient } from '../src/workshop-client.js';

test('browser keeps one assistant across publications and game navigation, refreshing its context every time', async t => {
  const originals = new Map();
  const install = (key, value) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const storage = new Map([['arcade:codex:session:hub', 'old-race-session']]);
  install('sessionStorage', { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) });
  install('EventSource', class { addEventListener() {} close() {} });
  const calls = [];
  install('fetch', async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    return { ok: true, json: async () => url.endsWith('/state') ? { sessions: [] }
      : { sessionId: 'assistant-session', threadId: 'thread', mode: 'hub', gameId: null } };
  });
  const client = new WorkshopClient();
  t.after(() => {
    client.dispose();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  const first = await client._ensureSession({ mode: 'hub', selectedGameId: 'race' });
  const request = calls.find(call => call.url.endsWith('/session')).body;
  assert.equal(request.mode, 'assistant');
  assert.equal(request.gameId, undefined);
  assert.equal(request.sessionId, undefined, 'legacy ID must never be sent');
  assert.equal(storage.get('arcade:codex:session:assistant'), first.sessionId);
  await client._receive({ type: 'game-updated', gameId: 'new-one', sessionId: 'new-one-session', revision: '1' });
  await client._receive({ type: 'game-updated', gameId: 'new-two', sessionId: 'new-two-session', revision: '2' });
  assert.equal((await client._ensureSession({ mode: 'hub' })).sessionId, first.sessionId);
  assert.equal(storage.get('arcade:codex:session:assistant'), first.sessionId);
  assert.equal(storage.get('arcade:codex:session:new-two'), 'new-two-session');
  const edited = await client._ensureSession({ mode: 'game', gameId: 'race', state: { score: 42 } });
  assert.equal(edited.sessionId, first.sessionId);
  assert.equal(calls.at(-1).body.context.gameId, 'race');
  assert.equal(calls.at(-1).body.context.state.score, 42);
  await client._ensureSession({ mode: 'hub', gameId: null });
  assert.equal(calls.at(-1).body.context.mode, 'hub');
  assert.equal(client.session.sessionId, first.sessionId);
});
