import test from "node:test";
import assert from "node:assert/strict";
import { Color } from "three";
import { ASTRA_PHOSPHOR } from "../src/robot-voice-display.js";
import { createRobotFaceController, createRobotFaceDisplay, createRobotLogoTexture, getRobotFaceTarget } from "../src/robot-face.js";

const quietMicrophone = { connected: true, microphone: "ready", inputActive: false, outputActive: false };
const step = (controller, options, seconds = 1) => {
  let status;
  for (let frame = 0; frame < seconds * 60; frame++) {
    status = controller.update({ ...options, elapsed: (options.elapsed || 0) + frame / 60, delta: 1 / 60 });
  }
  return status;
};

test("robot face: eyes are the default, with a short rare signature only when idle", () => {
  let logoSeconds = 0;
  for (let elapsed = 0; elapsed < 104; elapsed += .05) {
    const face = getRobotFaceTarget({ elapsed });
    if (face.mode === "logo") logoSeconds += .05;
    else assert.equal(face.mode, "eyes");
  }
  assert.ok(logoSeconds > 2 && logoSeconds < 3, `${logoSeconds} seconds of logo in 104 seconds`);
  assert.equal(getRobotFaceTarget({ elapsed: 46.6, focused: true }).mode, "eyes");
  assert.equal(getRobotFaceTarget({ elapsed: 46.6, state: "building" }).mode, "working");
});

test("robot face: every real work phase requests an indeterminate loading morph", () => {
  for (const state of ["thinking", "working", "building", "testing", "applying"]) {
    const face = getRobotFaceTarget({ state, voiceActive: true, activity: quietMicrophone });
    assert.equal(face.mode, "working");
    assert.equal(face.loading, 1);
    assert.equal(face.voice, 0, "a quiet open microphone must not hide game generation");
    assert.equal("progress" in face, false);
  }
  assert.equal(getRobotFaceTarget({ state: "ready" }).loading, 0);
  assert.equal(getRobotFaceTarget({ state: "idle" }).loading, 0);
});

test("robot face: interrupted morphs continue from the visible shape, without hard swaps", () => {
  const controller = createRobotFaceController();
  controller.update({ state: "idle", elapsed: 0, delta: 1 / 60 });
  const entered = controller.update({ state: "building", elapsed: 1 / 60, delta: 1 / 60 });
  assert.ok(entered.loading > 0 && entered.loading < .15);
  const midway = step(controller, { state: "testing", elapsed: .03 }, .15);
  assert.ok(midway.loading > .4 && midway.loading < .9);
  const interrupted = controller.update({ state: "ready", elapsed: .2, delta: 1 / 60 });
  assert.ok(interrupted.loading < midway.loading && interrupted.loading > midway.loading - .1);
  const settled = step(controller, { state: "idle", elapsed: 1 }, 2);
  assert.ok(settled.loading < .001);
  assert.equal(settled.mode, "eyes");
});

test("robot face: ready alone never celebrates; a publication smiles for a bounded interval", () => {
  assert.equal(getRobotFaceTarget({ state: "ready", elapsed: 10 }).celebrating, false);
  assert.equal(getRobotFaceTarget({ state: "ready", elapsed: 10, completedAt: 11 }).celebrating, false);
  const publication = getRobotFaceTarget({ state: "ready", elapsed: 10, completedAt: 10 });
  assert.equal(publication.mode, "celebrating");
  assert.equal(publication.joy, 1);
  assert.equal(getRobotFaceTarget({ state: "ready", elapsed: 14, completedAt: 10 }).celebrating, true);
  assert.equal(getRobotFaceTarget({ state: "ready", elapsed: 15, completedAt: 10 }).celebrating, false);
  assert.equal(getRobotFaceTarget({ state: "building", elapsed: 12, completedAt: 10 }).celebrating, false);
});

test("robot face: measured speech and actionable voice diagnostics take priority over loading", () => {
  for (const activity of [
    { ...quietMicrophone, inputActive: true, inputWaveform: [0, .1, -.1, 0] },
    { ...quietMicrophone, outputActive: true, outputLevel: .4 },
  ]) {
    const face = getRobotFaceTarget({ state: "building", voiceActive: true, activity });
    assert.equal(face.mode, "voice");
    assert.equal(face.loading, 1, "the loader retains its state behind speech");
  }
  assert.equal(getRobotFaceTarget({ state: "building", diagnostic: { code: "no-input" } }).mode, "voice");
  for (const state of ["listening", "speaking", "processing"]) {
    const quiet = getRobotFaceTarget({ state, voiceActive: true, activity: { ...quietMicrophone, inputLevel: 1, outputLevel: 1 } });
    assert.equal(quiet.presentation.mode, "ready", "status/levels alone must not fabricate speech");
    assert.equal(quiet.presentation.input, false);
    assert.equal(quiet.presentation.output, false);
  }
});

test("robot face: mechanical gaze and continuous eyelids retain expression in focused view", () => {
  const face = getRobotFaceTarget({
    focused: true, pose: { face: { look: .07, lookY: -.025, blink: .7, curiosity: .8, smile: .3 } },
  });
  assert.equal(face.look, .07);
  assert.equal(face.lookY, -.025);
  assert.equal(face.blink, .7);
  assert.equal(face.curiosity, .8);
  assert.equal(face.smile, .3);
});

test("robot face: reduced motion keeps eyes and loader static while preserving state and real speech", () => {
  const first = getRobotFaceTarget({ elapsed: 1, reducedMotion: true });
  const later = getRobotFaceTarget({ elapsed: 46.6, reducedMotion: true });
  assert.deepEqual(first, later);
  const display = createRobotFaceDisplay({ reducedMotion: true, logoUrl: null });
  display.update({ state: "building", elapsed: 1 });
  assert.equal(display.material.uniforms.uTime.value, 0);
  display.update({ state: "building", elapsed: 100 });
  assert.equal(display.material.uniforms.uTime.value, 0);
  assert.equal(display.status.mode, "working");
  display.dispose();
});

test("robot face: idle animation stays in one unlit material without canvas allocations/uploads", () => {
  const display = createRobotFaceDisplay({ logoUrl: null });
  const uniforms = display.material.uniforms;
  const texture = uniforms.uVoiceTexture.value;
  const version = texture.version;
  for (let frame = 0; frame < 300; frame++) display.update({ elapsed: frame / 60, delta: 1 / 60 });
  assert.equal(display.material.isShaderMaterial, true);
  assert.equal(display.material.toneMapped, false);
  assert.ok(uniforms.uPhosphor.value.equals(new Color(ASTRA_PHOSPHOR)));
  assert.equal(display.status.voiceUploads, 0);
  assert.equal(display.status.voiceWidth, 0);
  assert.equal(uniforms.uVoiceTexture.value, texture);
  assert.equal(texture.version, version);
  assert.equal(texture.flipY, false);
  display.dispose();
  display.dispose();
});

test("robot face: decoded SVG is rasterized once instead of uploading an SVG image to WebGL", () => {
  const image = { naturalWidth: 150, naturalHeight: 150, width: 150, height: 150, src: "/assets/logos/openai.svg" };
  const calls = [];
  const canvas = { width: 0, height: 0, getContext() {
    return {
      clearRect: (...args) => calls.push(["clear", ...args]),
      drawImage: (...args) => calls.push(["draw", ...args]),
    };
  } };
  const texture = createRobotLogoTexture(image, () => canvas);
  assert.equal(texture.isCanvasTexture, true);
  assert.equal(texture.image, canvas, "WebGL receives a fixed bitmap canvas, never an SVG image");
  assert.equal(texture.image.width, 256);
  assert.equal(texture.image.height, 256);
  assert.equal(texture.flipY, false);
  assert.equal(texture.generateMipmaps, false);
  assert.deepEqual(calls, [["clear", 0, 0, 256, 256], ["draw", image, 0, 0, 256, 256]]);
  assert.equal(texture.version, 1, "one initial upload, no second mutation of immutable storage");
  texture.dispose();
});

// Canvas spies prove sizing/upload scheduling, not microphone capture,
// playback or a real Codex session. Those require separate integration QA.
function withCanvas(callback) {
  const previous = globalThis.document;
  const transforms = [];
  globalThis.document = {
    createElement() {
      return { width: 0, height: 0, getContext() {
        return new Proxy({}, {
          get(target, key) {
            if (key in target) return target[key];
            if (key === "createRadialGradient") return () => ({ addColorStop() {} });
            if (key === "setTransform") return (...args) => transforms.push(args);
            return () => {};
          },
          set(target, key, value) { target[key] = value; return true; },
        });
      } };
    },
  };
  try { callback(transforms); }
  finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
}

test("robot face: live voice textures are capped at 256/512 and quiet sessions do not upload every frame", () => withCanvas((transforms) => {
  const display = createRobotFaceDisplay({ logoUrl: null });
  const options = { voiceActive: true, activity: quietMicrophone, focused: false, delta: 1 / 60 };
  for (let frame = 0; frame < 300; frame++) display.update({ ...options, elapsed: frame / 60 });
  assert.equal(display.status.voiceWidth, 256);
  assert.equal(display.status.voiceUploads, 1);
  assert.equal(transforms[0][0], .25, "labels use the existing 1024-wide design grid");
  assert.equal(display.material.uniforms.uVoiceTexture.value.flipY, false);
  display.update({ ...options, focused: true, elapsed: 5 });
  assert.equal(display.status.voiceWidth, 512);
  assert.equal(display.status.voiceUploads, 2);
  assert.equal(transforms[1][0], .5);
  const active = { ...quietMicrophone, inputActive: true, inputWaveform: [0, .2, -.2, 0] };
  for (let frame = 0; frame < 60; frame++) display.update({ ...options, focused: true, activity: active, elapsed: 6 + frame / 60 });
  assert.ok(display.status.voiceUploads <= 18, `${display.status.voiceUploads} uploads`);
  display.dispose();
}));
