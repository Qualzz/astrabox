import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Black-box contract tests: only our disposable HTTP server is contacted.
// In particular, these tests neither launch Codex nor use its authentication.
const CLI = fileURLToPath(new URL('../scripts/arcade.mjs', import.meta.url));
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';
const THREAD = 'mock-codex-thread';

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function fixture(t, options = {}) {
  const value = {
    calls: [], streams: new Set(), errors: [], timers: new Set(),
    session: { sessionId: SESSION, threadId: THREAD, gameId: 'line-pong', published: true, ...options.session },
    state: options.state ?? { sessions: [] },
  };
  value.event = (event) => {
    const data = { sessionId: SESSION, timestamp: Date.now(), ...event };
    for (const stream of value.streams) stream.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  value.later = (callback, milliseconds = 20) => {
    const timer = setTimeout(() => { value.timers.delete(timer); callback(); }, milliseconds);
    value.timers.add(timer);
  };
  value.server = http.createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const call = { method: request.method, path: request.url, body: body ? JSON.parse(body) : null };
      value.calls.push(call);
      if (options.onRequest?.(call, response, value)) return;
      if (call.path === '/api/games' && call.method === 'GET') {
        return json(response, 200, { games: [{ id: 'line-pong', title: 'Line Pong', maxPlayers: 2, revision: 'r-before' }] });
      }
      if (call.path === '/api/status' && call.method === 'GET') {
        return json(response, 200, { connected: true, authenticated: true, requiresLogin: false, message: 'Mock Codex connected' });
      }
      if (call.path === '/api/workshop/state' && call.method === 'GET') return json(response, 200, value.state);
      if (call.path === '/api/workshop/session' && call.method === 'POST') return json(response, 200, value.session);
      if (call.path === `/api/workshop/${SESSION}/events` && call.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write(': connected\n\n');
        value.streams.add(response);
        response.on('close', () => value.streams.delete(response));
        for (const event of options.history ?? []) value.event(event);
        options.onEvents?.(value, response);
        return;
      }
      if (call.path === `/api/workshop/${SESSION}/message` && call.method === 'POST') {
        if (options.onMessage) options.onMessage(value, call, response);
        else {
          value.event({ type: 'message', role: 'user', text: call.body.text });
          value.event({ type: 'status', state: 'ready', message: 'Request handled' });
        }
        if (!response.headersSent) json(response, 202, { ok: true });
        return;
      }
      json(response, 404, { error: `Unexpected mock route: ${call.method} ${call.path}` });
    } catch (error) {
      value.errors.push(error);
      if (!response.headersSent) json(response, 500, { error: error.message });
      else response.end();
    }
  });
  await new Promise((resolve, reject) => {
    value.server.once('error', reject);
    value.server.listen(0, '127.0.0.1', resolve);
  });
  value.url = `http://127.0.0.1:${value.server.address().port}`;
  t.after(async () => {
    for (const timer of value.timers) clearTimeout(timer);
    value.server.closeAllConnections();
    await new Promise((resolve) => value.server.close(resolve));
    assert.deepEqual(value.errors, [], 'the mock server must not mask handler failures');
  });
  return value;
}

async function run(t, args, url, { limit = 6_000 } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, ARCADE_URL: url, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', forced = false;
  child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
  const timer = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, limit);
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); });
  const startedAt = Date.now();
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, output: stdout + stderr, elapsed: Date.now() - startedAt }));
  });
  clearTimeout(timer);
  assert.equal(forced, false, `CLI did not exit within ${limit} ms:\n${result.output}`);
  assert.equal(result.signal, null, `CLI unexpectedly terminated by ${result.signal}:\n${result.output}`);
  return result;
}

function assertNoVoiceOrCancellation(value) {
  assert.ok(value.calls.every((call) => !/\/(voice|interrupt)(\/|$)/.test(call.path)), 'the text CLI must not start/stop voice or cancel the running job');
}

test('remote CLI forwards explicit model and effort as settings, not prompt text', async t => {
  const value = await fixture(t);
  const result = await run(t, ['edit', 'line-pong', 'Make the background teal.', '--model', 'gpt-6-astra', '--effort', 'low'], value.url);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(value.calls.find(call => call.path.endsWith('/message')).body,
    { text: 'Make the background teal.', model: 'gpt-6-astra', effort: 'low' });
  assertNoVoiceOrCancellation(value);
});

test('remote CLI list reads the real catalogue endpoint without creating a session', async (t) => {
  const value = await fixture(t);
  const result = await run(t, ['list'], value.url);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /line-pong/);
  assert.deepEqual(value.calls.map(({ method, path }) => [method, path]), [['GET', '/api/games']]);
});

test('remote CLI status reads connectivity and active sessions without sending instructions', async (t) => {
  const value = await fixture(t, { state: { sessions: [{ sessionId: SESSION, gameId: 'line-pong', state: 'building', message: 'Adjusting paddles', published: true, voice: false }] } });
  const result = await run(t, ['status'], value.url);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /authenticated=true/);
  assert.match(result.stdout, /line-pong/);
  assert.match(result.stdout, /building/);
  assert.deepEqual(value.calls.map(({ method, path }) => [method, path]).sort(), [['GET', '/api/status'], ['GET', '/api/workshop/state']]);
});

for (const command of ['new', 'edit']) {
  test(`remote CLI ${command} --no-wait enqueues text in the intended session without voice or SSE`, async (t) => {
    const value = await fixture(t, { session: command === 'new' ? { gameId: 'game-new', published: false } : {} });
    const text = 'Make a tiny arcade with jumping frogs.';
    const args = command === 'new' ? ['new', text, '--no-wait'] : ['edit', 'line-pong', text, '--no-wait'];
    const result = await run(t, args, value.url);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, new RegExp(`SESSION sessionId=${SESSION}`));
    assert.match(result.stdout, new RegExp(`threadId=${THREAD}`));
    assert.match(result.stdout, /gameId=/);
    assert.deepEqual(value.calls.map(({ method, path }) => [method, path]), [
      ['POST', '/api/workshop/session'], ['POST', `/api/workshop/${SESSION}/message`],
    ]);
    assert.deepEqual(value.calls[0].body, { gameId: command === 'new' ? null : 'line-pong' });
    assert.deepEqual(value.calls[1].body, { text });
    assertNoVoiceOrCancellation(value);
  });
}

test('remote CLI opens SSE before posting and reports the new publication, never a replayed completion', async (t) => {
  const text = 'Make the paddle yellow.';
  const old = Date.now() - 60_000;
  const value = await fixture(t, {
    history: [
      { type: 'message', role: 'user', text, timestamp: old },
      { type: 'status', state: 'error', message: 'OLD ERROR', timestamp: old },
      { type: 'game-updated', gameId: 'line-pong', revision: 'r-old', timestamp: old },
      { type: 'status', state: 'ready', message: 'OLD READY', timestamp: old },
    ],
    onMessage(value, call) {
      assert.equal(value.streams.size, 1, 'the event subscription must precede the text request');
      value.event({ type: 'message', role: 'user', text: call.body.text });
      value.event({ type: 'status', state: 'building', message: 'Changing the paddle' });
      value.event({ type: 'message', role: 'assistant', text: 'The paddle is now yellow.' });
      value.event({ type: 'game-updated', gameId: 'line-pong', revision: 'r-yellow' });
      value.event({ type: 'status', state: 'ready', message: 'Published' });
    },
  });
  const result = await run(t, ['edit', 'line-pong', text], value.url);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(value.calls.slice(0, 3).map(({ method, path }) => [method, path]), [
    ['POST', '/api/workshop/session'], ['GET', `/api/workshop/${SESSION}/events`], ['POST', `/api/workshop/${SESSION}/message`],
  ]);
  assert.match(result.stdout, /\[building\] Changing the paddle/);
  assert.match(result.stdout, /CODEX: The paddle is now yellow\./);
  assert.match(result.stdout, /PUBLISHED gameId=line-pong revision=r-yellow/);
  assert.doesNotMatch(result.output, /r-old|OLD ERROR|OLD READY/);
  assertNoVoiceOrCancellation(value);
});

test('remote CLI only arms completion for the matching fresh user acknowledgement', async (t) => {
  const text = 'Add a dash.';
  const value = await fixture(t, {
    onMessage(value, call) {
      value.event({ type: 'message', role: 'assistant', text: call.body.text });
      value.event({ type: 'status', state: 'ready', message: 'WRONG ROLE' });
      value.event({ type: 'message', role: 'user', text: 'Someone else changed the game.' });
      value.event({ type: 'game-updated', gameId: 'line-pong', revision: 'r-unrelated' });
      value.event({ type: 'message', role: 'user', text: call.body.text, sessionId: OTHER_SESSION });
      value.event({ type: 'status', state: 'error', message: 'WRONG SESSION' });
      value.event({ type: 'message', role: 'user', text: call.body.text, timestamp: Date.now() - 60_000 });
      value.event({ type: 'status', state: 'idle', message: 'OLD ACK' });
      value.later(() => {
        value.event({ type: 'message', role: 'user', text: call.body.text });
        value.event({ type: 'game-updated', gameId: 'line-pong', revision: 'r-dash' });
      });
    },
  });
  const result = await run(t, ['edit', 'line-pong', text, '--timeout', '1'], value.url);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /PUBLISHED gameId=line-pong revision=r-dash/);
  assert.doesNotMatch(result.output, /r-unrelated|WRONG ROLE|WRONG SESSION|OLD ACK/);
});

for (const state of ['ready', 'idle']) {
  test(`remote CLI ${state} terminates without claiming an unobserved publication`, async (t) => {
    const value = await fixture(t, {
      onMessage(value, call) {
        value.event({ type: 'message', role: 'user', text: call.body.text });
        value.event({ type: 'message', role: 'assistant', text: 'Which colour would you like?' });
        value.event({ type: 'status', state, message: 'Waiting for the visitor' });
      },
    });
    const result = await run(t, ['new', 'Create a game.'], value.url);
    assert.equal(result.code, 0, result.output);
    assert.match(result.stdout, new RegExp(`${state.toUpperCase()} sessionId=${SESSION}`));
    assert.doesNotMatch(result.stdout, /PUBLISHED/);
    assert.match(result.stdout, /CODEX: Which colour would you like\?/);
  });
}

test('remote CLI surfaces a live failure as exit 1 and does not cancel the session', async (t) => {
  const value = await fixture(t, {
    onMessage(value, call) {
      value.event({ type: 'message', role: 'user', text: call.body.text });
      value.event({ type: 'status', state: 'error', message: 'Validation rejected the cartridge' });
    },
  });
  const result = await run(t, ['edit', 'line-pong', 'Change the rules.'], value.url);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Validation rejected the cartridge/);
  assert.doesNotMatch(result.stdout, /PUBLISHED/);
  assertNoVoiceOrCancellation(value);
});

test('remote CLI deadline exits 2 promptly while leaving the queued job running', async (t) => {
  const value = await fixture(t, {
    onMessage(value, call) {
      value.event({ type: 'message', role: 'user', text: call.body.text });
      value.event({ type: 'status', state: 'building', message: 'Still building' });
    },
  });
  const result = await run(t, ['new', 'Create a game.', '--timeout', '0.1'], value.url);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /TIMEOUT/);
  assert.ok(result.elapsed < 3_000, `0.1 second deadline took ${result.elapsed} ms`);
  assert.equal(value.calls.filter((call) => call.path.endsWith('/message')).length, 1);
  assertNoVoiceOrCancellation(value);
});

test('remote CLI deadline also bounds a pending message response after the request was queued', async (t) => {
  const value = await fixture(t, {
    onMessage(value, call, response) {
      value.event({ type: 'message', role: 'user', text: call.body.text });
      value.event({ type: 'status', state: 'building', message: 'Working while the HTTP reply is delayed' });
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.write('{"ok":');
      value.later(() => response.end('true}'), 1_500);
    },
  });
  const result = await run(t, ['new', 'Create a game.', '--timeout', '0.1'], value.url);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /TIMEOUT/);
  assert.ok(result.elapsed < 1_000, `The pending POST bypassed the deadline (${result.elapsed} ms)`);
  assertNoVoiceOrCancellation(value);
});

test('remote CLI wait deadline also bounds a delayed current-state snapshot', async (t) => {
  const value = await fixture(t, {
    onRequest(call, response, value) {
      if (call.path !== '/api/workshop/state') return false;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"sessions":');
      value.later(() => response.end(JSON.stringify([{ sessionId: SESSION, gameId: 'line-pong', state: 'building' }]) + '}'), 1_500);
      return true;
    },
  });
  const result = await run(t, ['wait', SESSION, '--timeout', '0.1'], value.url);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /TIMEOUT/);
  assert.ok(result.elapsed < 1_000, `The pending snapshot bypassed the deadline (${result.elapsed} ms)`);
  assertNoVoiceOrCancellation(value);
});

for (const state of ['ready', 'idle', 'error']) {
  test(`remote CLI wait respects the current ${state} snapshot without resurrecting historical events`, async (t) => {
    const value = await fixture(t, { state: { sessions: [{ sessionId: SESSION, gameId: 'line-pong', state, message: 'Current final state', published: true, voice: false }] } });
    // State semantics, not a timing test: leave room for concurrent Chromium work on a Pi.
    // The short-deadline behavior is exercised independently above.
    const result = await run(t, ['wait', SESSION, '--timeout', '1'], value.url);
    assert.equal(result.code, state === 'error' ? 1 : 0, result.output);
    assert.ok(value.calls.some((call) => call.path === '/api/workshop/state'));
    assert.ok(value.calls.every((call) => call.method === 'GET'));
    assert.doesNotMatch(result.stdout, /PUBLISHED/);
    if (state !== 'error') assert.match(result.stdout, new RegExp(`${state.toUpperCase()} sessionId=${SESSION}`));
    assertNoVoiceOrCancellation(value);
  });
}

test('remote CLI wait follows an active session and ignores old ready/error replay', async (t) => {
  const value = await fixture(t, {
    state: { sessions: [{ sessionId: SESSION, gameId: 'line-pong', state: 'building', message: 'Working', published: true, voice: false }] },
    history: [
      { type: 'status', state: 'ready', message: 'OLD WAIT READY', timestamp: Date.now() - 60_000 },
      { type: 'status', state: 'error', message: 'OLD WAIT ERROR', timestamp: Date.now() - 60_000 },
    ],
    onEvents(value) {
      value.later(() => {
        value.event({ type: 'status', state: 'testing', message: 'Testing current change' });
        value.event({ type: 'game-updated', gameId: 'line-pong', revision: 'r-waited' });
      });
    },
  });
  const result = await run(t, ['wait', SESSION, '--timeout', '1'], value.url);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stdout, /PUBLISHED gameId=line-pong revision=r-waited/);
  assert.doesNotMatch(result.output, /OLD WAIT READY|OLD WAIT ERROR/);
  assert.ok(value.calls.every((call) => call.method === 'GET'));
});

test('remote CLI wait rejects an unknown session rather than starting a new thread', async (t) => {
  const value = await fixture(t);
  // This checks the unknown-session response, not a 100 ms startup deadline.
  // Concurrent browser tests on the Pi can consume that before the state GET.
  const result = await run(t, ['wait', SESSION, '--timeout', '1'], value.url);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /Session introuvable/);
  assert.ok(value.calls.every((call) => call.method === 'GET'));
  assert.ok(value.calls.some((call) => call.path === '/api/workshop/state'));
});

test('remote CLI refuses non-local origins and URL credentials/path/query before making any request', async (t) => {
  const value = await fixture(t);
  const invalid = [
    'https://example.com', 'http://192.168.1.2:8080', 'file:///tmp/arcade',
    `http://someone:secret@127.0.0.1:${value.server.address().port}`,
    `${value.url}/nested`, `${value.url}?target=other`, `${value.url}#fragment`,
  ];
  for (const url of invalid) {
    const result = await run(t, ['new', 'Do not send this request.', '--no-wait'], url);
    assert.notEqual(result.code, 0, `Rejected URL unexpectedly succeeded: ${url}`);
  }
  assert.deepEqual(value.calls, []);
});

test('remote CLI never follows HTTP redirects, including a redirect to another local route', async (t) => {
  const value = await fixture(t, {
    onRequest(call, response) {
      if (call.path !== '/api/games') return false;
      response.writeHead(302, { Location: '/redirect-target' });
      response.end();
      return true;
    },
  });
  const result = await run(t, ['list'], value.url);
  assert.notEqual(result.code, 0, result.output);
  assert.deepEqual(value.calls.map(({ path }) => path), ['/api/games']);
});

test('remote CLI reports HTTP errors and never posts text after a refused session creation', async (t) => {
  const value = await fixture(t, {
    onRequest(call, response) {
      if (call.path !== '/api/workshop/session') return false;
      json(response, 503, { error: 'Mock Codex unavailable' });
      return true;
    },
  });
  const result = await run(t, ['new', 'Create a game.', '--no-wait'], value.url);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Mock Codex unavailable/);
  assert.deepEqual(value.calls.map(({ path }) => path), ['/api/workshop/session']);
});

test('remote CLI validates commands, identifiers and bounded deadlines before requesting a session', async (t) => {
  const value = await fixture(t);
  const invalid = [
    ['new'], ['new', '   '], ['edit', 'line-pong'], ['edit', '../outside', 'Change it.'],
    ['wait', 'not-a-session'], ['new', 'Create it.', '--timeout', '0'],
    ['new', 'Create it.', '--timeout', '601'], ['new', 'Create it.', '--timeout', 'NaN'],
    ['new', 'Create it.', '--unknown'], ['not-a-command'],
  ];
  for (const args of invalid) {
    const result = await run(t, args, value.url);
    assert.notEqual(result.code, 0, `Invalid arguments unexpectedly accepted: ${JSON.stringify(args)}`);
  }
  assert.deepEqual(value.calls, []);
});
