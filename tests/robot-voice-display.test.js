import test from "node:test";
import assert from "node:assert/strict";
import { drawRobotVoiceDisplay, getRobotVoicePresentation } from "../src/robot-voice-display.js";

const ready = { connected: true, microphone: "ready", inputActive: false, outputActive: false };

// This Canvas spy verifies rendering decisions, not microphone access or a
// remote conversation. Browser / real-service checks remain separate.
function render(options = {}) {
  const calls = [];
  const context = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createRadialGradient") return () => ({ addColorStop() {} });
      return (...args) => calls.push([key, ...args]);
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const presentation = drawRobotVoiceDisplay(context, { width: 1024, height: 826, elapsed: 1, ...options });
  return { calls, presentation };
}

test("robot TV: status events and levels alone never fabricate speaking activity", () => {
  for (const state of ["listening", "speaking", "processing", "heard"]) {
    const presentation = getRobotVoicePresentation({ state, voiceActive: true, activity: { ...ready, inputLevel: 1, outputLevel: 1 } });
    assert.equal(presentation.input, false);
    assert.equal(presentation.output, false);
    assert.equal(presentation.mode, "ready");
  }
});

test("robot TV: measured microphone activity shows a waveform, not a service acknowledgment", () => {
  const presentation = getRobotVoicePresentation({ state: "listening", voiceActive: true, activity: { ...ready, inputActive: true } });
  assert.equal(presentation.mode, "input");
  assert.equal(presentation.label, "VOUS PARLEZ");
  assert.equal(presentation.hint, "PARLEZ, PUIS FAITES UNE PAUSE");
  assert.equal(presentation.footer, "B · TERMINER");
  assert.equal(getRobotVoicePresentation({ state: "heard", voiceActive: true, activity: ready }).label, "BIEN REÇU");
});

test("robot TV: playback and simultaneous microphone signals retain separate visual channels", () => {
  const presentation = getRobotVoicePresentation({ voiceActive: true, activity: { ...ready, outputActive: true, inputActive: true } });
  assert.equal(presentation.mode, "output");
  assert.equal(presentation.label, "CODEX PARLE");
  assert.equal(presentation.input, true);
  assert.equal(presentation.output, true);
});

test("robot TV: muted or disconnected microphones cannot show a live input waveform", () => {
  for (const microphone of ["permission", "muted", "ended", "off"]) {
    assert.equal(getRobotVoicePresentation({ voiceActive: true, activity: { ...ready, microphone, inputActive: true } }).input, false);
  }
  assert.equal(getRobotVoicePresentation({ voiceActive: true, activity: { ...ready, connected: false, inputActive: true, outputActive: true } }).mode, "ready");
});

test("robot TV: diagnostic states give distinct actionable instructions", () => {
  const cases = [
    ["permission-denied", "AUTORISEZ LE MICRO", "DANS LE NAVIGATEUR · A"],
    ["playback-blocked", "SON BLOQUÉ", "A · ACTIVER LE SON"],
    ["audio-suspended", "SON BLOQUÉ", "A · ACTIVER LE SON"],
    ["no-input", "MICRO SILENCIEUX", "VÉRIFIEZ LE MICRO SÉLECTIONNÉ"],
    ["microphone-muted", "MICRO MUET", "RÉACTIVEZ VOTRE MICRO"],
    ["awaiting-service", "RÉPONSE EN ATTENTE", "LE MICRO CAPTE VOTRE VOIX"],
  ];
  for (const [code, label, hint] of cases) {
    const presentation = getRobotVoicePresentation({ voiceActive: true, activity: ready, diagnostic: { code } });
    assert.equal(presentation.label, label);
    assert.equal(presentation.hint, hint);
  }
});

test("robot TV: quiet input is a stationary line, never a fallback sine wave", () => {
  const options = { voiceActive: true, activity: { ...ready, inputActive: true, inputWaveform: [0, 0, 0, 0] } };
  const first = render({ ...options, elapsed: 1 });
  const later = render({ ...options, elapsed: 20 });
  const geometry = (result) => result.calls.filter(([name]) => ["moveTo", "lineTo"].includes(name));
  assert.deepEqual(geometry(first), geometry(later));
  assert(geometry(first).every(([, , y]) => y === 826 * 0.43));
  const active = render({ ...options, activity: { ...options.activity, inputWaveform: [0, 0.4, -0.4, 0] } });
  assert(geometry(active).some(([, , y]) => y !== 826 * 0.43));
});

test("robot TV: orb deformation depends on measured playback strength", () => {
  const coordinates = (level, elapsed) => render({
    voiceActive: true,
    activity: { ...ready, outputActive: true, outputLevel: level }, elapsed,
  }).calls.filter(([name]) => name === "lineTo");
  assert.deepEqual(coordinates(0, 1), coordinates(0, 10));
  assert.notDeepEqual(coordinates(0.7, 1), coordinates(0.7, 10));
  assert.equal(render({ voiceActive: true, activity: ready }).calls.some(([name]) => name === "fill"), false);
});

test("robot TV: reduced motion removes time-driven deformation without hiding audio activity", () => {
  const draw = (elapsed) => render({ reducedMotion: true, elapsed, voiceActive: true, activity: { ...ready, outputActive: true, outputLevel: 0.7 } });
  assert.deepEqual(draw(1).calls, draw(10).calls);
  assert.equal(draw(1).presentation.label, "CODEX PARLE");
});
