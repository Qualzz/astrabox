import test from "node:test";
import assert from "node:assert/strict";
import { WorkshopClient } from "../src/workshop-client.js";

// Browser/transport fixtures: these tests make no real microphone or Codex call.
function fixture(t, { playBlocked = false, microphoneDenied = false, nativeFailure = false } = {}) {
  const original = new Map();
  function install(name, value) {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  const requests = [];
  const frames = new Map();
  let frameId = 0;
  let getUserMediaCalls = 0;
  class Track extends EventTarget {
    constructor() { super(); this.readyState = "live"; this.enabled = true; this.muted = false; this.stopped = 0; }
    stop() { this.stopped += 1; this.readyState = "ended"; }
  }
  const track = new Track();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const remoteTrack = new Track();
  const remoteStream = { getTracks: () => [remoteTrack], getAudioTracks: () => [remoteTrack] };
  const audio = { autoplay: false, srcObject: null, playCalls: 0, pauseCalls: 0, setAttribute() {},
    play() { this.playCalls += 1; return playBlocked ? Promise.reject(new Error("blocked")) : Promise.resolve(); },
    pause() { this.pauseCalls += 1; } };
  class Context {
    constructor() { this.state = "running"; this.closed = 0; this.resumeCalls = 0; }
    resume() { this.resumeCalls += 1; this.state = "running"; return Promise.resolve(); }
    close() { this.closed += 1; this.state = "closed"; return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { getFloatTimeDomainData: (samples) => samples.fill(0), disconnect() {} }; }
  }
  class Peer extends EventTarget {
    constructor() { super(); this.connectionState = "new"; this.closed = 0; this.tracks = []; this.sent = []; }
    addTrack(...args) { this.tracks.push(args); }
    createDataChannel() { return { send: (data) => this.sent.push(data), close() {}, onmessage: null }; }
    createOffer() { return Promise.resolve({ type: "offer", sdp: "v=offer" }); }
    setLocalDescription(description) { this.localDescription = description; return Promise.resolve(); }
    setRemoteDescription(description) {
      this.remoteDescription = description;
      this.connectionState = "connected";
      this.ontrack?.({ streams: [remoteStream], track: remoteTrack });
      this.dispatchEvent(new Event("connectionstatechange"));
      return Promise.resolve();
    }
    close() { this.closed += 1; this.connectionState = "closed"; }
  }
  install("AudioContext", Context);
  install("requestAnimationFrame", (callback) => { frames.set(++frameId, callback); return frameId; });
  install("cancelAnimationFrame", (id) => frames.delete(id));
  install("navigator", { mediaDevices: { getUserMedia() {
    getUserMediaCalls += 1;
    return microphoneDenied ? Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })) : Promise.resolve(stream);
  } } });
  install("RTCPeerConnection", Peer);
  install("document", { createElement: () => audio });
  install("fetch", async (url, options = {}) => {
    requests.push({ url, body: options.body && JSON.parse(options.body) });
    return { ok: !(nativeFailure && url.endsWith("/voice/start")), status: 503,
      json: async () => url.endsWith("/state") ? { sessions: [] }
        : url.endsWith("/voice/start") ? nativeFailure ? { error: "Native voice unavailable" } : { sdp: "v=answer" } : {} };
  });
  const client = new WorkshopClient();
  client._ensureSession = async () => (client.session = { sessionId: "test-session", threadId: "same-codex-thread" });
  const states = [], activity = [], diagnostics = [], statuses = [];
  client.addEventListener("voice-state", (event) => states.push(event.detail));
  client.addEventListener("voice-activity", (event) => activity.push(event.detail));
  client.addEventListener("voice-diagnostic", (event) => diagnostics.push(event.detail));
  client.addEventListener("status", (event) => statuses.push(event.detail));
  t.after(() => {
    client.dispose();
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  return { client, track, remoteTrack, requests, frames, audio, states, activity, diagnostics, statuses,
    getUserMediaCalls: () => getUserMediaCalls, unblockPlayback: () => { playBlocked = false; } };
}

test("voice begins streaming, START is idempotent, and stop releases the graph and owned tracks", async (t) => {
  const f = fixture(t);
  await f.client.startVoice();
  const meter = f.client.audioMeter;
  const peer = f.client.peer;
  assert.equal(f.client.voiceActive, true);
  assert.equal(f.client.voiceStarting, false);
  assert.ok(f.client.voiceConnectedAt);
  assert.equal(meter.connected, true);
  assert.equal(f.audio.srcObject.getAudioTracks()[0], f.remoteTrack);
  assert.equal(f.states.at(-1).state, "listening");
  await f.client.startVoice();
  assert.equal(f.getUserMediaCalls(), 1);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/voice/start")).length, 1);
  assert.equal(meter.context.resumeCalls, 2);
  assert.equal(f.client.peer, peer);
  await f.client.stopVoice();
  assert.equal(f.track.stopped, 1);
  assert.equal(f.remoteTrack.stopped, 0);
  assert.equal(peer.closed, 1);
  assert.equal(meter.context.closed, 1);
  assert.equal(f.frames.size, 0);
  assert.equal(f.client.voiceActive, false);
  assert.equal(f.activity.at(-1).microphone, "off");
  assert.deepEqual(peer.sent, []); // no manual commit, flush or response.create
});

test("permission rejection is visible and closes the pre-created audio graph", async (t) => {
  const f = fixture(t, { microphoneDenied: true });
  await assert.rejects(f.client.startVoice(), /Microphone refusé/);
  assert.equal(f.client.voiceActive, false);
  assert.equal(f.frames.size, 0);
  assert.equal(f.statuses.at(-1).state, "error");
  assert.equal(f.requests.some((request) => request.url.endsWith("/voice/start")), false);
});

test("STOP during pending permission stays closed and stops a microphone granted later", async t => {
  const f = fixture(t);
  let grant;
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const starting = f.client.startVoice();
  await f.client.stopVoice();
  await starting;
  assert.equal(f.client.voiceActive, false);
  assert.equal(f.frames.size, 0);
  grant({ getTracks: () => [f.track], getAudioTracks: () => [f.track] });
  await Promise.resolve();
  assert.equal(f.track.stopped, 1);
  assert.equal(f.requests.some(request => request.url.endsWith("/voice/start")), false);
});

test("fast STOP then reopen waits for the old remote stop without a stale idle status", async t => {
  const f = fixture(t);
  await f.client.startVoice();
  const fetch = f.client._fetch.bind(f.client);
  let finishStop;
  f.client._fetch = (url, ...args) => url.endsWith("/voice/stop")
    ? new Promise(resolve => { finishStop = resolve; }) : fetch(url, ...args);
  const stopping = f.client.stopVoice();
  assert.equal(f.track.stopped, 1);
  assert.equal(f.audio.srcObject, null);
  // A fresh physical stream, represented by a reset fixture track.
  f.track.readyState = "live";
  const reopening = f.client.startVoice();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.filter(request => request.url.endsWith("/voice/start")).length, 1);
  assert.equal(f.statuses.at(-1).state, "connecting");
  finishStop({});
  await stopping;
  assert.equal(f.statuses.at(-1).state, "connecting");
  await reopening;
  assert.equal(f.client.voiceActive, true);
  assert.equal(f.statuses.at(-1).state, "listening");
  assert.equal(f.requests.filter(request => request.url.endsWith("/voice/start")).length, 2);
});

test("native error is never replaced by another voice service and stops the microphone", async (t) => {
  const f = fixture(t, { nativeFailure: true });
  await assert.rejects(f.client.startVoice(), /Native voice unavailable/);
  assert.equal(f.track.stopped, 1);
  assert.equal(f.frames.size, 0);
  assert.equal(f.client.voiceActive, false);
  assert.equal(f.statuses.at(-1).message, "Native voice unavailable");
  assert.ok(f.requests.every((request) => request.url.startsWith("/api/workshop")));
});

test("blocked audible playback has a START retry without discarding the live conversation", async (t) => {
  const f = fixture(t, { playBlocked: true });
  await f.client.startVoice();
  assert.equal(f.client.voiceActive, true);
  assert.equal(f.diagnostics.at(-1).code, "playback-blocked");
  assert.match(f.diagnostics.at(-1).message, /START/);
  f.unblockPlayback();
  await f.client.startVoice();
  assert.equal(f.diagnostics.at(-1).code, null);
  assert.equal(f.getUserMediaCalls(), 1);
  assert.equal(f.requests.filter((request) => request.url.endsWith("/voice/start")).length, 1);
});

test("mic mute is distinguishable from silence and disconnect ends the call with an error", async (t) => {
  const f = fixture(t);
  await f.client.startVoice();
  f.track.muted = true;
  f.track.dispatchEvent(new Event("mute"));
  assert.equal(f.diagnostics.at(-1).code, "microphone-muted");
  assert.equal(f.activity.at(-1).microphone, "muted");
  f.track.muted = false;
  f.track.dispatchEvent(new Event("unmute"));
  assert.equal(f.diagnostics.at(-1).code, null);
  f.track.readyState = "ended";
  f.track.dispatchEvent(new Event("ended"));
  assert.equal(f.client.voiceActive, false);
  assert.match(f.statuses.at(-1).message, /déconnecté/);
  assert.equal(f.frames.size, 0);
});

test("local sound feedback is not speech recognition; silent diagnostics clear on real signal", async (t) => {
  const f = fixture(t);
  await f.client.startVoice();
  f.client.voiceConnectedAt = Date.now() - 11_000;
  const silent = f.client.audioMeter.sample();
  f.client._onVoiceActivity(silent);
  assert.equal(f.diagnostics.at(-1).code, "no-input");
  f.client._onVoiceActivity({ ...silent, inputActive: true, signalDetected: true, inputLevel: 0.4 });
  assert.equal(f.diagnostics.at(-1).code, null);
  assert.equal(f.states.some((event) => event.state === "heard"), false);
  f.client._receiveVoiceEvent({ type: "conversation.item.input_audio_transcription.completed" });
  assert.equal(f.states.at(-1).state, "heard");
});

test("server VAD stops a sentence without closing the conversation or committing manually", async (t) => {
  const f = fixture(t);
  await f.client.startVoice();
  f.client._receiveVoiceEvent({ type: "input_audio_buffer.speech_started" });
  assert.equal(f.states.at(-1).inputAcknowledged, true);
  f.client._receiveVoiceEvent({ type: "input_audio_buffer.speech_stopped" });
  assert.equal(f.states.at(-1).state, "processing");
  f.client._receiveVoiceEvent({ type: "output_audio_buffer.started" });
  assert.equal(f.states.at(-1).state, "speaking");
  f.client._receiveVoiceEvent({ type: "output_audio_buffer.stopped" });
  assert.equal(f.states.at(-1).state, "listening");
  assert.deepEqual(f.client.peer.sent, []);
  assert.equal(f.client.voiceActive, true);
});

test("fresh user SSE transcript confirms reception, old replay does not", async (t) => {
  const f = fixture(t);
  await f.client.startVoice();
  await f.client._receive({ type: "transcript", role: "user", text: "Old", done: true, timestamp: f.client.voiceConnectedAt - 5000 });
  assert.equal(f.states.some((event) => event.state === "heard"), false);
  await f.client._receive({ type: "transcript", role: "user", text: "Current", done: true, timestamp: Date.now() });
  assert.equal(f.states.at(-1).state, "heard");
});

test("actual native v3 event names acknowledge speech and a response without fake audio activity", async (t) => {
  const f = fixture(t);
  await f.client.startVoice();
  f.client.pendingInputAt = Date.now() - 20_000;
  f.client._diagnostic("awaiting-service", "En attente");
  f.client._receiveVoiceEvent({ type: "input_transcript.added", item: { text: " " } });
  assert.equal(f.states.some((event) => event.state === "heard"), false);
  f.client._receiveVoiceEvent({ type: "turn.created", turn: { id: "user-turn", role: "user" } });
  assert.equal(f.states.at(-1).state, "listening");
  f.client._receiveVoiceEvent({ type: "input_transcript.added", start_ms: 0, end_ms: 400, item: { id: "word-1", type: "input_transcript", text: "Bonjour" } });
  assert.equal(f.states.at(-1).state, "heard");
  assert.equal(f.states.at(-1).inputAcknowledged, true);
  assert.equal(f.client.pendingInputAt, 0);
  assert.equal(f.diagnostics.at(-1).code, null);
  f.client._receiveVoiceEvent({ type: "turn.done", turn: { id: "user-turn", role: "user", transcript: "Bonjour" } });
  assert.equal(f.states.at(-1).state, "processing");
  f.client._receiveVoiceEvent({ type: "turn.created", turn: { id: "assistant-turn", role: "assistant" } });
  assert.equal(f.states.at(-1).state, "processing");
  f.client._receiveVoiceEvent({ type: "output_transcript.added", item: { id: "answer-1", type: "output_transcript", text: " Oui." } });
  assert.equal(f.states.some((event) => event.state === "speaking"), false);
  f.client._receiveVoiceEvent({ type: "turn.done", turn: { id: "assistant-turn", role: "assistant", transcript: "Oui." } });
  assert.equal(f.states.at(-1).state, "listening");
  assert.deepEqual(f.client.peer.sent, []);
});

test("a service acknowledgement does not restart its pending timer on the same audio tail", async (t) => {
  const f = fixture(t);
  await f.client.startVoice();
  const active = { ...f.client.audioMeter.sample(), inputActive: true, signalDetected: true };
  f.client._onVoiceActivity(active);
  assert.ok(f.client.pendingInputAt);
  f.client._receiveVoiceEvent({ type: "input_transcript.added", item: { type: "input_transcript", text: "Bonjour" } });
  f.client._onVoiceActivity(active);
  assert.equal(f.client.pendingInputAt, 0);
  assert.equal(f.client.inputAcknowledged, true);
});

test("stale session control events cannot cancel a new voice attempt before the peer connects", async (t) => {
  const f = fixture(t);
  const transcriptHistory = [], messageHistory = [], publications = [];
  f.client.addEventListener("transcript", (event) => transcriptHistory.push(event.detail));
  f.client.addEventListener("message", (event) => messageHistory.push(event.detail));
  f.client.addEventListener("game-updated", (event) => publications.push(event.detail));
  const ensureSession = f.client._ensureSession;
  f.client._ensureSession = async () => {
    const session = await ensureSession();
    const history = { sessionId: session.sessionId, timestamp: Date.now() - 30_000 };
    assert.equal(f.client.voiceStarting, true);
    assert.equal(f.client.voiceConnectedAt, 0);
    // Real server history contains status/message. Also defend against a late
    // queued old close (voice-closed itself is not currently replay-persisted).
    await f.client._receive({ ...history, type: "voice-closed", reason: "Previous call ended" });
    for (const state of ["idle", "error", "connecting", "listening", "speaking", "processing", "heard", "building", "ready"]) {
      await f.client._receive({ ...history, type: "status", state, message: "STALE STATUS" });
    }
    await f.client._receive({ ...history, type: "transcript", role: "user", text: "Ancienne phrase", done: true });
    await f.client._receive({ ...history, type: "message", role: "user", text: "Ancienne demande" });
    await f.client._receive({ ...history, type: "game-updated", gameId: "fixture-game", revision: "saved-revision" });
    return session;
  };
  await f.client.startVoice();
  assert.equal(f.client.voiceActive, true);
  assert.equal(f.client.voiceStarting, false);
  assert.equal(f.states.at(-1).state, "listening");
  assert.equal(f.statuses.some((status) => status.message === "STALE STATUS"), false);
  assert.equal(f.states.some((state) => state.state === "heard"), false);
  assert.equal(transcriptHistory[0].text, "Ancienne phrase");
  assert.equal(messageHistory[0].text, "Ancienne demande");
  assert.equal(publications[0].revision, "saved-revision");
  assert.equal(f.track.stopped, 0);
  assert.equal(f.client.workState, "idle"); // old build/ready history is not current work
});

test("a fresh close during startup still cancels the attempt and releases the microphone", async (t) => {
  const f = fixture(t);
  const ensureSession = f.client._ensureSession;
  f.client._ensureSession = async () => {
    const session = await ensureSession();
    await f.client._receive({ type: "voice-closed", sessionId: session.sessionId, timestamp: Date.now() });
    return session;
  };
  await f.client.startVoice();
  assert.equal(f.client.voiceActive, false);
  assert.equal(f.track.stopped, 1);
  assert.equal(f.frames.size, 0);
  assert.equal(f.requests.some((request) => request.url.endsWith("/voice/start")), false);
});

test("current errors and closes are effective, but another session's close cannot kill this call", async (t) => {
  const f = fixture(t);
  await f.client.startVoice();
  await f.client._receive({ type: "voice-closed", sessionId: "another-session", timestamp: Date.now() });
  assert.equal(f.client.voiceActive, true);
  await f.client._receive({ type: "status", state: "error", message: "Fresh voice error", sessionId: "test-session", timestamp: Date.now() });
  assert.equal(f.statuses.at(-1).message, "Fresh voice error");
  await f.client._receive({ type: "voice-closed", sessionId: "test-session", timestamp: Date.now() });
  assert.equal(f.client.voiceActive, false);
  assert.equal(f.track.stopped, 1);
});

test("fresh global work state still restores an active build while call history is filtered", async (t) => {
  const f = fixture(t);
  await f.client.startVoice();
  await f.client._receive({ type: "workshop-status", sessionId: "test-session", state: "building", message: "Current work" });
  await f.client._receive({ type: "status", sessionId: "test-session", state: "idle", timestamp: f.client.voiceAttemptAt - 1 });
  assert.equal(f.client.workState, "building");
  await f.client.stopVoice();
  assert.equal(f.client.workState, "building");
});
