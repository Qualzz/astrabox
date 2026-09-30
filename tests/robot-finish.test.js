import test from "node:test";
import assert from "node:assert/strict";
import { BoxGeometry, Color, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, ShaderLib } from "three";
import { applyRobotFinish, ROBOT_FINISH_PALETTE, ROBOT_SUCCESS_SECONDS, robotStatusLight } from "../src/robot-finish.js";
import { createLunarMaterialSimplifier } from "../src/lunar-render-profile.js";
import { skipZeroLightContributions } from "../src/sparse-lighting.js";

test("robot palette matches warm cabinet while Ultra and completion colours remain distinct", () => {
  const enamel = new Color(ROBOT_FINISH_PALETTE.enamel);
  const tire = new Color(ROBOT_FINISH_PALETTE.tire);
  const blue = new Color(ROBOT_FINISH_PALETTE.blue);
  const ready = new Color(ROBOT_FINISH_PALETTE.ready);
  assert.ok(enamel.r > enamel.g && enamel.g > enamel.b);
  assert.ok(tire.r > tire.g && tire.g > tire.b);
  assert.ok(enamel.r > tire.r * 3);
  assert.ok(blue.b > blue.r && blue.b > blue.g);
  assert.ok(ready.g > ready.r && ready.g > ready.b);
});

test("green is tied to an actual recent completion, never a permanent ready/idle state", () => {
  assert.equal(robotStatusLight({ elapsed: 100 }).ready, 0);
  assert.equal(robotStatusLight({ elapsed: 0 }).ready, 0);
  assert.equal(robotStatusLight({ elapsed: 100, completedAt: 100 }).ready, 1);
  assert.equal(robotStatusLight({ elapsed: 100, completedAt: 101 }).ready, 0);
  assert.equal(robotStatusLight({ elapsed: 100 + ROBOT_SUCCESS_SECONDS, completedAt: 100 }).ready, 0);
  assert.equal(robotStatusLight({ elapsed: 100, completedAt: 100, working: true }).mode, "working");
  assert.equal(robotStatusLight({ elapsed: 100, completedAt: 100, working: true }).ready, 0);
  for (let age = -1; age < 8; age += .01) {
    const state = robotStatusLight({ elapsed: 100 + age, completedAt: 100 });
    assert.ok(state.ready >= 0 && state.ready <= 1);
    assert.ok(state.working >= 0 && state.working <= 1);
  }
  assert.equal(robotStatusLight({ elapsed: 50, working: true, reducedMotion: true }).phase, 0);
  assert.equal(robotStatusLight({ elapsed: 50, working: true, reducedMotion: true }).working, 1);
});

function robotFixture() {
  const root = new Group(), source = new MeshStandardMaterial({ color: "blue" });
  const mesh = (name, material = source) => { const part = new Mesh(new BoxGeometry(), material); part.name = name; root.add(part); return part; };
  const shell = mesh("head-shell"), cover = mesh("chassis-top-cover"), tire = mesh("tire-fl"), hub = mesh("hub-fl");
  const front = mesh("lamp-lens-front"), rear = mesh("lamp-lens-rear");
  const screen = mesh("robot-screen", new MeshBasicMaterial());
  return { root, source, shell, cover, tire, hub, front, rear, screen };
}

test("finish reuses mesh geometry, preserves display and installs one shared uniform-only status shader", () => {
  const fixture = robotFixture();
  const { root, source, shell, cover, tire, front, rear, screen } = fixture;
  const originalGeometry = shell.geometry, screenMaterial = screen.material;
  const initialCount = root.children.length;
  const finish = applyRobotFinish(root);
  assert.equal(root.children.length, initialCount);
  assert.equal(shell.geometry, originalGeometry);
  assert.equal(screen.material, screenMaterial);
  assert.notEqual(shell.material, source);
  assert.notEqual(shell.material, cover.material);
  assert.equal(front.material, rear.material);
  assert.ok(front.material.isShaderMaterial);
  assert.equal(tire.material.metalness, 0);
  assert.ok(tire.material.roughness > .8);
  assert.equal(front.material.toneMapped, false);
  const uniforms = front.material.uniforms;
  for (let i = 0; i < 90; i++) finish.update({ elapsed: i / 60, delta: 1 / 60, working: true });
  assert.ok(uniforms.uWorking.value > .999);
  assert.equal(uniforms.uReady.value, 0);
  for (let i = 0; i < 90; i++) finish.update({ elapsed: 2 + i / 60, delta: 1 / 60, completedAt: 2 });
  assert.ok(uniforms.uWorking.value < .001);
  assert.ok(uniforms.uReady.value > .999);
  for (let i = 0; i < 90; i++) finish.update({ elapsed: 10 + i / 60, delta: 1 / 60, completedAt: 2 });
  assert.ok(uniforms.uReady.value < .001);
  assert.equal(finish.status.mode, "idle");
  finish.dispose();
  assert.equal(shell.material, source);
  assert.equal(front.material, source);
});

test("grain and wheel-local markings survive sparse light and Pi Phong shader hooks", () => {
  const { root, shell, tire, hub } = robotFixture();
  const finish = applyRobotFinish(root);
  const simplify = createLunarMaterialSimplifier();
  let grain;
  for (const part of [shell, tire, hub]) {
    skipZeroLightContributions(part.material);
    for (const [material, shaderType] of [[part.material, "standard"], [simplify(part.material, { highlights: true }), "phong"]]) {
      const shader = { uniforms: {}, vertexShader: ShaderLib[shaderType].vertexShader, fragmentShader: ShaderLib[shaderType].fragmentShader };
      material.onBeforeCompile(shader);
      assert.match(shader.vertexShader, /vRobotFinishPosition = position/);
      assert.match(shader.fragmentShader, /vec2 finishGrain = robotGrain/);
      assert.match(material.customProgramCacheKey(), /llm-vintage-/);
      if (part === tire || part === hub) assert.match(shader.fragmentShader, /atan\(vRobotFinishPosition.z, vRobotFinishPosition.y\)/);
      if (grain) assert.equal(shader.uniforms.uRobotGrain.value, grain);
      grain = shader.uniforms.uRobotGrain.value;
      assert.equal(grain.image.width, 64);
      assert.equal(grain.generateMipmaps, true);
      const version = grain.version;
      finish.update({ elapsed: 12, working: true });
      assert.equal(grain.version, version, "animation must not re-upload grain texture");
    }
  }
  finish.dispose();
});
