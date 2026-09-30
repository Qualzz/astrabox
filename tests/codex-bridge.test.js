import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { CodexBridge, CodexRpcError } from "../server/codex-bridge.js";
import { WorkshopClient } from "../src/workshop-client.js";

function fakeTransport(respond = () => {}) {
  const child = new EventEmitter();
  const received = [];
  const invocations = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      const message = JSON.parse(chunk.toString());
      received.push(message);
      queueMicrotask(() => {
        if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "mock-codex" } })}\n`);
        else respond(message, child);
      });
      callback();
    },
  });
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit", 0));
  };
  const spawnImpl = (...args) => { invocations.push(args); return child; };
  return { child, received, invocations, spawnImpl };
}

test("initializes the real CLI command once and negotiates experimental APIs", async (t) => {
  const fake = fakeTransport();
  const bridge = new CodexBridge({ spawnImpl: fake.spawnImpl });
  t.after(() => bridge.close());
  const [a, b] = await Promise.all([bridge.connect(), bridge.connect()]);
  assert.equal(a.userAgent, "mock-codex");
  assert.deepEqual(a, b);
  assert.equal(fake.invocations.length, 1);
  assert.deepEqual(fake.invocations[0][1], ["app-server", "--enable", "realtime_conversation", "--enable", "fast_mode", "--listen", "stdio://"]);
  assert.equal(fake.received[0].params.capabilities.experimentalApi, true);
  assert.equal(fake.received[1].method, "initialized");
  assert.equal(fake.received[0].jsonrpc, undefined);
});

test("multiplexes concurrent requests and exposes structured RPC errors", async (t) => {
  const fake = fakeTransport((message, child) => {
    if (!message.id) return;
    child.stdout.write(`${JSON.stringify(message.method === "bad"
      ? { id: message.id, error: { code: -32601, message: "Unknown method", data: { method: "bad" } } }
      : { id: message.id, result: { value: message.params.value } })}\n`);
  });
  const bridge = new CodexBridge({ spawnImpl: fake.spawnImpl });
  t.after(() => bridge.close());
  const values = await Promise.all([bridge.request("first", { value: 1 }), bridge.request("second", { value: 2 })]);
  assert.deepEqual(values, [{ value: 1 }, { value: 2 }]);
  await assert.rejects(bridge.request("bad"), (error) => error instanceof CodexRpcError && error.code === -32601);
  assert.equal(bridge.pending.size, 0);
});

test("handles UTF-8 split across chunks, notifications, and server requests", async (t) => {
  const fake = fakeTransport();
  const bridge = new CodexBridge({ spawnImpl: fake.spawnImpl });
  t.after(() => bridge.close());
  await bridge.connect();
  const notification = new Promise((resolve) => bridge.once("notification", resolve));
  const bytes = Buffer.from(`${JSON.stringify({ method: "message", params: { text: "déjà" } })}\n`);
  const boundary = bytes.indexOf(Buffer.from("é")) + 1;
  fake.child.stdout.write(bytes.subarray(0, boundary));
  fake.child.stdout.write(bytes.subarray(boundary));
  assert.deepEqual(await notification, { method: "message", params: { text: "déjà" } });
  const request = new Promise((resolve) => bridge.once("request", resolve));
  fake.child.stdout.write('{"id":"server-1","method":"item/tool/call","params":{"name":"capture_game"}}\n');
  assert.equal((await request).id, "server-1");
  bridge.respond("server-1", { success: true });
  bridge.respondError("server-2", -32601, "Not supported");
  assert.deepEqual(fake.received.at(-2), { id: "server-1", result: { success: true } });
  assert.equal(fake.received.at(-1).error.code, -32601);
});

test("times out requests, rejects in-flight work on disconnect, and closes cleanly", async (t) => {
  const fake = fakeTransport();
  const bridge = new CodexBridge({ spawnImpl: fake.spawnImpl });
  t.after(() => bridge.close());
  await bridge.connect();
  await assert.rejects(bridge.request("never", {}, 10), /délai/);
  const pending = bridge.request("pending");
  await new Promise((resolve) => setImmediate(resolve));
  fake.child.emit("exit", 1);
  await assert.rejects(pending, /fermée/);
  assert.equal(bridge.pending.size, 0);
  bridge.close();
  await assert.rejects(bridge.connect(), /fermé/);
});

test("does not expose invalid protocol content in errors", async (t) => {
  const fake = fakeTransport();
  const bridge = new CodexBridge({ spawnImpl: fake.spawnImpl });
  t.after(() => bridge.close());
  await bridge.connect();
  const disconnected = new Promise((resolve) => bridge.once("disconnect", resolve));
  fake.child.stdout.write("not-json-secret-material\n");
  const error = await disconnected;
  assert.match(error.message, /JSONL/);
  assert.doesNotMatch(error.message, /secret-material/);
  assert.equal(fake.child.killed, true);
});

function mockBrowser(t, handler = () => ({})) {
  const sources = [];
  const requests = [];
  const storage = new Map();
  class MockEventSource extends EventTarget {
    constructor(url) { super(); this.url = url; sources.push(this); }
    close() { this.closed = true; }
  }
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, body, init });
    const result = handler(url, body);
    return { ok: true, json: async () => result };
  });
  const originalSource = globalThis.EventSource;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  globalThis.EventSource = MockEventSource;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) } });
  t.after(() => {
    if (originalSource) globalThis.EventSource = originalSource;
    else delete globalThis.EventSource;
    if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else delete globalThis.sessionStorage;
  });
  return { sources, requests, storage };
}

test("text refreshes game context in the same persistent assistant conversation", async (t) => {
  const browser = mockBrowser(t, (url) => url.endsWith("/session") ? { sessionId: "session-1", threadId: "thread-1" } : { ok: true });
  browser.storage.set("arcade:codex:session:assistant", "previous-session");
  const client = new WorkshopClient({ getGameContext: () => ({ gameId: "pong", screenshot: "local-game-only" }) });
  t.after(() => client.dispose());
  await client.sendText("Ralentis la balle");
  await client.sendText("Remets comme avant");
  const sessions = browser.requests.filter((request) => request.url.endsWith("/session"));
  assert.equal(sessions.length, 2, "refresh context on each request, not a second conversation");
  assert.equal(sessions[1].body.sessionId, "session-1");
  assert.equal(sessions[1].body.mode, "assistant");
  assert.equal(browser.sources.filter(source => source.url.includes("/api/workshop/")).length, 1);
  assert.equal(browser.requests.find((request) => request.url.endsWith("/session")).body.sessionId, "previous-session");
  assert.equal(browser.requests.at(-1).url, "/api/workshop/session-1/message");
  assert.equal(browser.requests.at(-1).body.context.screenshot, "local-game-only");
  assert.equal(client.voiceActive, false);
  await client._receive({ type: "capture-request", requestId: "capture-1" });
  assert.equal(browser.requests.at(-1).body.requestId, "capture-1");
});

test("deduplicates published revisions and shares the creation thread with the new cartridge", async (t) => {
  const browser = mockBrowser(t);
  const updates = [];
  const client = new WorkshopClient({ onGameUpdated: (event) => updates.push(event) });
  const event = { type: "game-updated", gameId: "new-game", sessionId: "creation-thread-session", revision: "hash-1" };
  await client._receive(event);
  await client._receive(JSON.stringify(event));
  assert.equal(updates.length, 1);
  assert.equal(browser.storage.get("arcade:codex:session:new-game"), "creation-thread-session");
  client.dispose();
  assert.ok(browser.sources.every((source) => source.closed));
});

test("global capture serves a remote voice session without a local session or microphone", async (t) => {
  const browser = mockBrowser(t);
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let microphones = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => { microphones += 1; } } } });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
  let captures = 0;
  const client = new WorkshopClient({ getGameContext: async () => {
    captures += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return { gameId: "pong", screenshot: "current-cartridge-image" };
  } });
  t.after(() => client.dispose());
  const data = JSON.stringify({ type: "capture-request", sessionId: "phone-session", gameId: "pong", requestId: "remote-capture" });
  browser.sources[0].dispatchEvent(new MessageEvent("capture-request", { data }));
  browser.sources[0].onmessage({ data });
  await new Promise((resolve) => setImmediate(resolve));
  const posts = browser.requests.filter(({ url }) => url.endsWith("/context"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "/api/workshop/phone-session/context");
  assert.deepEqual(posts[0].body, { context: { gameId: "pong", screenshot: "current-cartridge-image" }, requestId: "remote-capture" });
  assert.equal(captures, 1);
  assert.equal(client.session, null);
  assert.equal(microphones, 0);
  assert.equal(client.voiceActive, false);
  assert.equal(browser.requests.filter(({ url }) => url.endsWith("/session")).length, 0);
});

test("capture requests never send a different game's screen or duplicate across session and global streams", async (t) => {
  const browser = mockBrowser(t, (url) => url.endsWith("/session") ? { sessionId: "local-session", threadId: "local-thread" } : {});
  const client = new WorkshopClient({ getGameContext: () => ({ gameId: "pong", screenshot: "pong-only" }) });
  t.after(() => client.dispose());
  await client.sendText("Contexte local");
  await client._receive({ type: "capture-request", sessionId: "remote-session", gameId: "breakout", requestId: "wrong-game" });
  await client._receive({ type: "capture-request", sessionId: "remote-session", requestId: "missing-game" });
  assert.equal(browser.requests.filter(({ url }) => url.endsWith("/context")).length, 0);
  const data = JSON.stringify({ type: "capture-request", sessionId: "local-session", gameId: "pong", requestId: "same-capture" });
  browser.sources[0].dispatchEvent(new MessageEvent("capture-request", { data }));
  browser.sources.find(({ url }) => url === "/api/workshop/local-session/events").onmessage({ data });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.requests.filter(({ url }) => url.endsWith("/context")).length, 1);
});

test("receives named and default global SSE events without publishing duplicates", async (t) => {
  const browser = mockBrowser(t);
  const updates = [];
  const client = new WorkshopClient({ onGameUpdated: (event) => updates.push(event) });
  t.after(() => client.dispose());
  const data = JSON.stringify({ type: "game-updated", gameId: "pong", revision: "r2" });
  const named = new MessageEvent("game-updated", { data });
  browser.sources[0].dispatchEvent(named);
  browser.sources[0].onmessage({ data });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(updates.length, 1);
  assert.equal(updates[0].gameId, "pong");
});

test("a background thumbnail event refreshes the catalogue without invoking gameplay reload", async t => {
  const browser = mockBrowser(t);
  const updates = [], thumbnails = [];
  const client = new WorkshopClient({ onGameUpdated: event => updates.push(event) });
  t.after(() => client.dispose());
  client.addEventListener("game-thumbnail-updated", event => thumbnails.push(event.detail));
  browser.sources[0].dispatchEvent(new MessageEvent("game-thumbnail-updated", {
    data: JSON.stringify({ type: "game-thumbnail-updated", gameId: "pong", revision: "r2" }),
  }));
  assert.equal(thumbnails.length, 1);
  assert.equal(updates.length, 0);
  assert.equal(client.seenRevisions.size, 0);
});

test("microphone is never opened during construction or text interaction", async (t) => {
  mockBrowser(t, (url) => url.endsWith("/session") ? { sessionId: "s", threadId: "t" } : {});
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let opened = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => { opened += 1; } } } });
  t.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
  const client = new WorkshopClient();
  await client.sendText("Bonjour");
  assert.equal(opened, 0);
  client.dispose();
});

function voiceBrowser(t, { getMicrophone, voiceStart } = {}) {
  const track = new EventTarget();
  track.stops = 0;
  track.readyState = "live";
  track.enabled = true;
  track.muted = false;
  track.stop = () => { track.stops += 1; track.readyState = "ended"; };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const peers = [];
  const contexts = [];
  const frames = new Map();
  let frameId = 0;
  class AudioContext {
    constructor() { this.state = "running"; this.closed = false; contexts.push(this); }
    async resume() { this.state = "running"; }
    async close() { this.state = "closed"; this.closed = true; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { getFloatTimeDomainData: (samples) => samples.fill(0), disconnect() {} }; }
  }
  class Peer extends EventTarget {
    constructor() { super(); this.connectionState = "new"; peers.push(this); }
    addTrack() {}
    createDataChannel(name) { this.channelName = name; return { close() { this.closed = true; } }; }
    async createOffer() { return { type: "offer", sdp: "v=0\r\no=browser-offer" }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; this.connectionState = "connected"; }
    close() { this.connectionState = "closed"; this.dispatchEvent(new Event("connectionstatechange")); }
  }
  const originals = new Map(["navigator", "RTCPeerConnection", "document", "AudioContext", "requestAnimationFrame", "cancelAnimationFrame"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: getMicrophone || (() => Promise.resolve(stream)) } } });
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, value: Peer });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ setAttribute() {}, async play() {}, pause() {} }) } });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: AudioContext });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback) => { frames.set(++frameId, callback); return frameId; } });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: (id) => frames.delete(id) });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const browser = mockBrowser(t, (url, body) => {
    if (url.endsWith("/session")) return { sessionId: "voice-session", threadId: "persistent-thread" };
    if (url.endsWith("/voice/start")) return voiceStart ? voiceStart(body) : { sdp: "v=0\r\no=codex-answer" };
    return {};
  });
  return { ...browser, track, stream, peers, contexts, frames };
}

test("voice exchanges SDP fixtures via the harness and releases microphone on stop", async (t) => {
  const browser = voiceBrowser(t);
  const client = new WorkshopClient({ getGameContext: () => ({ gameId: "pong" }) });
  t.after(() => client.dispose());
  await client.startVoice();
  assert.equal(client.voiceActive, true);
  assert.equal(browser.peers[0].channelName, "oai-events");
  assert.equal(browser.peers[0].remoteDescription.sdp, "v=0\r\no=codex-answer");
  assert.equal(browser.requests.find((request) => request.url.endsWith("/voice/start")).body.sdp, "v=0\r\no=browser-offer");
  await client.stopVoice();
  assert.equal(client.voiceActive, false);
  assert.equal(browser.track.stops, 1);
  assert.equal(browser.peers[0].connectionState, "closed");
  assert.equal(browser.contexts[0].closed, true);
  assert.equal(browser.frames.size, 0);
  assert.ok(browser.requests.some((request) => request.url.endsWith("/voice/stop")));
});

test("unavailable voice surfaces an honest error and shuts down all audio resources", async (t) => {
  const browser = voiceBrowser(t, { voiceStart: () => { throw new Error("Realtime unavailable for this account"); } });
  const client = new WorkshopClient();
  t.after(() => client.dispose());
  const statuses = [];
  client.addEventListener("status", ({ detail }) => statuses.push(detail));
  await assert.rejects(client.startVoice(), /Realtime unavailable/);
  assert.equal(browser.track.stops, 1);
  assert.equal(client.voiceActive, false);
  assert.equal(browser.peers[0].connectionState, "closed");
  assert.equal(statuses.at(-1).state, "error");
  assert.equal(browser.requests.filter((request) => request.url.endsWith("/message")).length, 0);
});

test("cancelling pending microphone permission stops a stream granted later", async (t) => {
  let grantMicrophone;
  const browser = voiceBrowser(t, { getMicrophone: () => new Promise((resolve) => { grantMicrophone = resolve; }) });
  const client = new WorkshopClient();
  t.after(() => client.dispose());
  const start = client.startVoice();
  await client.stopVoice();
  await start;
  grantMicrophone(browser.stream);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(browser.track.stops, 1);
  assert.equal(browser.requests.filter((request) => request.init.method !== "GET").length, 0);
  assert.equal(client.voiceActive, false);
});

test("page disposal closes voice and SSE while keeping the thread identity for later", async (t) => {
  const browser = voiceBrowser(t);
  const client = new WorkshopClient({ getGameContext: () => ({ gameId: "pong" }) });
  await client.startVoice();
  client.dispose();
  assert.equal(browser.track.stops, 1);
  assert.equal(client.voiceActive, false);
  assert.ok(browser.sources.every((source) => source.closed));
  assert.equal(browser.storage.get("arcade:codex:session:assistant"), "voice-session");
  assert.equal(browser.requests.at(-1).url, "/api/workshop/voice-session/voice/stop");
  assert.equal(browser.requests.at(-1).init.keepalive, true);
});

test("stopping voice does not invent a completed state for an ongoing build", async (t) => {
  voiceBrowser(t);
  const client = new WorkshopClient();
  t.after(() => client.dispose());
  const statuses = [];
  client.addEventListener("status", ({ detail }) => statuses.push(detail));
  await client.startVoice();
  await client._receive({ type: "status", state: "building", message: "Codex travaille." });
  await client.stopVoice();
  assert.equal(statuses.at(-1).state, "building");
});

test("restores and follows robot activity without opening a Codex thread or microphone", async (t) => {
  const browser = mockBrowser(t, (url) => url.endsWith("/state")
    ? { sessions: [{ sessionId: "building-session", gameId: "pong", state: "building", message: "Modification en cours." }] }
    : {});
  const client = new WorkshopClient();
  t.after(() => client.dispose());
  const statuses = [];
  client.addEventListener("workshop-status", ({ detail }) => statuses.push(detail));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(statuses.at(-1).state, "building");
  browser.sources[0].dispatchEvent(new MessageEvent("workshop-status", { data: JSON.stringify({ type: "workshop-status", sessionId: "building-session", gameId: "pong", state: "ready", message: "Terminé." }) }));
  assert.equal(statuses.at(-1).state, "ready");
  assert.equal(browser.requests.length, 1);
  assert.equal(browser.requests[0].init.method, "GET");
  assert.equal(client.session, null);
  assert.equal(client.voiceActive, false);
});
