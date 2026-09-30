import test from "node:test";
import assert from "node:assert/strict";
import { VoiceAudioMeter, measureSamples } from "../src/voice-audio-meter.js";

class FakeContext {
  constructor() { this.state = "running"; this.nodes = []; this.closed = 0; }
  resume() { this.state = "running"; return Promise.resolve(); }
  close() { this.closed += 1; this.state = "closed"; return Promise.resolve(); }
  createMediaStreamSource(stream) {
    const node = { stream, links: [], disconnected: 0, connect(target) { this.links.push(target); }, disconnect() { this.disconnected += 1; } };
    this.nodes.push(node);
    return node;
  }
  createAnalyser() {
    const node = { amplitude: 0, disconnected: 0, disconnect() { this.disconnected += 1; }, getFloatTimeDomainData(samples) {
      samples.forEach((_, index) => { samples[index] = Math.sin(index * 0.19) * this.amplitude; });
    } };
    this.nodes.push(node);
    return node;
  }
}

function fixture() {
  const frames = new Map();
  let nextFrame = 0;
  const events = [];
  const meter = new VoiceAudioMeter({ AudioContextClass: FakeContext, onActivity: (activity) => events.push(activity),
    requestFrame: (fn) => { frames.set(++nextFrame, fn); return nextFrame; }, cancelFrame: (id) => frames.delete(id) });
  const track = { readyState: "live", enabled: true, muted: false, stopped: 0, stop() { this.stopped += 1; } };
  const stream = { getAudioTracks: () => [track] };
  return { meter, track, stream, frames, events };
}

test("PCM analysis gives silence a flat line, detects waveform and removes DC offsets", () => {
  assert.deepEqual(measureSamples(new Float32Array(1024)), { rms: 0, level: 0, waveform: Array(64).fill(0) });
  assert.equal(measureSamples(new Float32Array(1024).fill(0.2)).rms, 0);
  const sound = measureSamples(Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.07) * 0.3));
  assert.ok(sound.rms > 0.2 && sound.level <= 1);
  assert.ok(sound.waveform.some((sample) => sample < -0.2));
  assert.ok(sound.waveform.some((sample) => sample > 0.2));
});

test("microphone and remote output are measured separately without audible destination", () => {
  const { meter, stream } = fixture();
  meter.setInputStream(stream);
  meter.setOutputStream(stream);
  meter.input.analyser.amplitude = 0.2;
  let activity = meter.sample();
  assert.equal(activity.inputActive, true);
  assert.equal(activity.outputActive, false);
  assert.equal(activity.signalDetected, true);
  meter.input.analyser.amplitude = 0;
  meter.output.analyser.amplitude = 0.15;
  activity = meter.sample();
  assert.equal(activity.inputActive, false);
  assert.equal(activity.outputActive, true);
  for (const kind of ["input", "output"]) assert.deepEqual(meter[kind].source.links, [meter[kind].analyser]);
  assert.equal(meter.context.nodes.length, 4); // no gain/destination or duplicate audible output
  meter.close();
});

test("muted, disabled and ended microphones cannot report a real input level", () => {
  const { meter, stream, track } = fixture();
  meter.setInputStream(stream);
  meter.input.analyser.amplitude = 0.2;
  for (const [property, value, state] of [["muted", true, "muted"], ["enabled", false, "muted"], ["readyState", "ended", "ended"]]) {
    track[property] = value;
    const activity = meter.sample();
    assert.equal(activity.microphone, state);
    assert.equal(activity.inputActive, false);
    assert.equal(activity.inputLevel, 0);
    assert.deepEqual(activity.inputWaveform, Array(64).fill(0));
  }
  meter.close();
});

test("suspended audio does not fabricate level feedback", () => {
  const { meter, stream } = fixture();
  meter.setInputStream(stream);
  meter.input.analyser.amplitude = 0.2;
  meter.context.state = "suspended";
  assert.equal(meter.sample().inputLevel, 0);
  assert.equal(meter.sample().audioContextState, "suspended");
  meter.close();
});

test("close cancels the frame and graph exactly once without stopping caller-owned tracks", () => {
  const { meter, stream, track, frames } = fixture();
  meter.setInputStream(stream);
  meter.setOutputStream(stream);
  const nodes = [...meter.context.nodes];
  meter.close();
  meter.close();
  assert.equal(frames.size, 0);
  assert.equal(meter.context.closed, 1);
  assert.equal(track.stopped, 0);
  assert.ok(nodes.every((node) => node.disconnected === 1));
});

test("replacing a remote stream disconnects its previous graph", () => {
  const { meter, stream } = fixture();
  meter.setOutputStream(stream);
  const old = meter.output;
  meter.setOutputStream(stream);
  assert.equal(old.source.disconnected, 1);
  assert.equal(old.analyser.disconnected, 1);
  assert.notEqual(old.source, meter.output.source);
  meter.close();
});
