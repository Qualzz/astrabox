import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeMidi, encodeMidi } from "../src/midi.js";
import { MidiPlayer } from "../src/midi-player.js";
import { ArcadeRuntime } from "../src/runtime.js";

const score = () => encodeMidi({ bpm: 120, beats: 4, tracks: [
  { channel: 0, program: 10, notes: [[0, 72, .5, 80], [2, 76, .5, 60]] },
  { channel: 1, program: 33, notes: [[0, 48, 1, 70]] },
] });

test("menu is a real compact MIDI with a complete 16-bar loop and bounded polyphony", async () => {
  const data = await readFile(new URL("../assets/audio/music/petite-orbite.mid", import.meta.url));
  assert.equal(data.subarray(0, 4).toString(), "MThd");
  assert.ok(data.length < 4000);
  const song = decodeMidi(data);
  assert.ok(Math.abs(song.duration - 64 * 60 / 92) < .001);
  assert.deepEqual([...new Set(song.notes.map(note => note.program))], [10, 33, 4]);
  for (const note of song.notes) {
    assert.ok(note.duration > 0 && note.time + note.duration <= song.duration);
    assert.ok(song.notes.filter(other => other.time <= note.time && other.time + other.duration > note.time).length <= 6);
  }
  assert.ok(song.notes.length > 100, "a composed melody, bass and accompaniment, not a placeholder beep");
});

test("MIDI encoder preserves channels, velocities, note lengths and trailing silence", () => {
  const song = decodeMidi(score());
  assert.equal(song.duration, 2);
  assert.deepEqual(song.notes.map(n => [n.time, n.pitch, n.duration, n.program, n.channel]), [[0, 72, .25, 10, 0], [0, 48, .5, 33, 1], [1, 76, .25, 10, 0]]);
  assert.equal(song.notes[0].velocity, 80 / 127);
  assert.throws(() => decodeMidi(score().slice(0, -2)), /tronqué/);
  assert.throws(() => decodeMidi(new Uint8Array(24)), /MIDI/);
  assert.throws(() => encodeMidi({ bpm: 0, beats: 4, tracks: [] }), /Tempo/);
});

test("MIDI format 1 merges its tempo map and reads running status / note-on velocity zero", () => {
  const track = data => [77, 84, 114, 107, 0, 0, 0, data.length, ...data];
  const song = decodeMidi(new Uint8Array([
    77, 84, 104, 100, 0, 0, 0, 6, 0, 1, 0, 2, 1, 224,
    ...track([0,255,81,3,7,161,32, 131,96,255,81,3,15,66,64, 131,96,255,47,0]),
    ...track([0,192,10, 0,144,60,100, 129,112,64,80, 129,112,60,0, 131,96,64,0, 0,255,47,0]),
  ]));
  assert.equal(song.duration, 1.5);
  assert.deepEqual(song.notes.map(n => [n.time, n.duration]), [[0, .5], [.25, 1.25]]);
});

function context() {
  const parameter = () => ({ value: 0, events: [],
    setValueAtTime(...args) { this.events.push(["set", ...args]); },
    linearRampToValueAtTime(...args) { this.events.push(["linear", ...args]); },
    exponentialRampToValueAtTime(...args) { this.events.push(["exponential", ...args]); },
    setTargetAtTime(...args) { this.events.push(["target", ...args]); },
    cancelScheduledValues() {},
  });
  return { state: "running", currentTime: 0, destination: {}, oscillators: [],
    createGain() { return { gain: parameter(), connect() {}, disconnect() {} }; },
    createPeriodicWave() { return {}; },
    createOscillator() {
      const oscillator = { frequency: parameter(), setPeriodicWave() {}, connect() {}, disconnect() {},
        start(time) { this.started = time; }, stop(time) { this.stopped = time; } };
      this.oscillators.push(oscillator); return oscillator;
    },
    async resume() { this.state = "running"; }, async close() { this.state = "closed"; },
  };
}
function player(t, options = {}) {
  const ctx = context(), doc = new EventTarget(); doc.hidden = false;
  const midi = new MidiPlayer({ contextFactory: () => ctx, document: doc, target: new EventTarget(),
    fetchFile: async () => ({ ok: true, arrayBuffer: async () => score().buffer }), ...options });
  t.after(() => midi.dispose());
  return { midi, ctx, doc };
}

test("default MIDI fetch keeps the browser global receiver instead of binding to the player", async t => {
  let fetched = false;
  t.mock.method(globalThis, 'fetch', async function (url) {
    assert.equal(this, globalThis);
    assert.equal(url, '/theme.mid');
    fetched = true;
    return { ok: true, arrayBuffer: async () => score().buffer };
  });
  const midi = new MidiPlayer({ active: false, document: null, target: null });
  t.after(() => midi.dispose());
  assert.equal(await midi.play('/theme.mid'), true);
  assert.equal(fetched, true);
});

test("music stays silent in preloaded games, ducks for voice and releases voices on exit/hidden tab", async t => {
  const { midi, ctx, doc } = player(t, { active: false });
  assert.equal(await midi.play("/theme.mid"), true);
  assert.equal(ctx.oscillators.length, 0);
  midi.setActive(true); await midi.reconcile();
  assert.equal(ctx.oscillators.length, 2);
  await midi.play("/theme.mid");
  assert.equal(ctx.oscillators.length, 2, "same URL must not restart or stack music");
  midi.setDucked(true);
  assert.equal(midi.output.gain.events.at(-1)[1], .22 * .12);
  midi.setDucked(false);
  assert.equal(midi.output.gain.events.at(-1)[1], .22);
  doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(midi.timer, null);
  assert.equal(midi.voices.size, 0);
  assert.ok(ctx.oscillators.every(osc => osc.stopped === .04));
  doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange"));
  await midi.reconcile();
  assert.ok(midi.timer);
  midi.setActive(false);
  assert.equal(midi.timer, null);
  midi.stop(); midi.setActive(true);
  assert.equal(midi.song, null);
  assert.equal(midi.timer, null);
});

test("stopped/replaced MIDI fetches cannot resurrect music; dispose closes the audio context", async t => {
  const resolves = [];
  const { midi, ctx } = player(t, { fetchFile: () => new Promise(resolve => resolves.push(resolve)) });
  const old = midi.play("/old.mid");
  const current = midi.play("/new.mid");
  resolves[1]({ ok: true, arrayBuffer: async () => score().buffer });
  await current;
  resolves[0]({ ok: true, arrayBuffer: async () => score().buffer });
  assert.equal(await old, false);
  assert.equal(midi.url, "/new.mid");
  const pending = midi.play("/pending.mid");
  midi.dispose();
  resolves[2]({ ok: true, arrayBuffer: async () => score().buffer });
  assert.equal(await pending, false);
  assert.equal(ctx.state, "closed");
  assert.equal(midi.timer, null);
});

test("audio clock loops once, skips stale notes after a stall and caps simultaneous voices", async t => {
  const { midi, ctx } = player(t);
  await midi.play("/loop.mid");
  ctx.currentTime = 20;
  const before = ctx.oscillators.length;
  midi.schedule();
  assert.equal(ctx.oscillators.length - before, 2, "no catch-up burst for ten missed loops");
  assert.ok(ctx.oscillators.at(-1).started >= 20);
  midi.stop();
  midi.song = { duration: 2, notes: Array.from({ length: 30 }, () => ({ time: 0, pitch: 60, duration: 1, program: 0, channel: 0, velocity: 1 })) };
  midi.origin = 20; midi.index = 0; midi.loop = true;
  midi.schedule();
  assert.equal(midi.voices.size, 12);
});

test("runtime wires pause and voice to music without pausing gameplay for a call", () => {
  const calls = [], runtime = Object.create(ArcadeRuntime.prototype);
  runtime.audio = { setMusicActive: value => calls.push(["active", value]), setMusicDucked: value => calls.push(["duck", value]) };
  runtime.workshopText = {};
  runtime.setPaused(true); runtime.setPaused(false);
  runtime.setWorkshopStatus({ open: true, voiceActive: true });
  assert.equal(runtime.paused, false);
  runtime.setWorkshopStatus({ open: false, voiceActive: false });
  assert.deepEqual(calls, [["active", false], ["active", true], ["duck", true], ["duck", false]]);
});
