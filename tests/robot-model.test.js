import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Group } from "three";
import { animateRobotRig, findRobotRig, robotIdlePose, ROBOT_IDLE_PERIOD, ROBOT_WHEEL_RADIUS } from "../src/robot-idle.js";

test("robot builder clears machine-specific paths before saving the shared Blender source", async () => {
  const source = await readFile(new URL("../art/robot/build_robot.py", import.meta.url), "utf8");
  const save = source.indexOf("bpy.ops.wm.save_as_mainfile(");
  assert.ok(save > 0);
  const beforeSave = source.slice(0, save);
  assert.match(beforeSave, /scene\.render\.filepath = ['"]_['"] \* 1023/);
  assert.match(beforeSave, /space\.params\.directory = b['"]_['"] \* 1023/);
  assert.match(beforeSave, /scene\.render\.filepath = ['"]\/\/output\/robot-authored\/articulated\.png['"]/);
  assert.match(beforeSave, /space\.type == ['"]FILE_BROWSER['"] and space\.params/);
  assert.match(beforeSave, /space\.params\.directory = b['"]\/\/['"]/);
  assert.match(source.slice(save), /bpy\.ops\.wm\.save_as_mainfile\([^\n]*relative_remap=False/);
});

test("authored robot GLB has independent head, steering/rolling axes and mapped TV glass", async () => {
  const data = await readFile(new URL("../assets/models/codex-robot-authored.glb", import.meta.url));
  assert.equal(data.readUInt32LE(0), 0x46546c67);
  const gltf = JSON.parse(data.subarray(20, 20 + data.readUInt32LE(12)).toString());
  const named = (name) => gltf.nodes.find((node) => node.name === name);
  assert.ok(named("head-yaw")); assert.ok(named("head-pitch"));
  for (const part of ["fl", "fr", "rl", "rr"]) {
    const steer = named(`wheel-steer-${part}`), spin = named(`wheel-spin-${part}`);
    assert.ok(steer && spin);
    assert.ok(steer.children.includes(gltf.nodes.indexOf(spin)));
    assert.ok(named(`tire-${part}`));
  }
  const screen = named("robot-screen");
  assert.equal(screen.extras.arcade_screen, true);
  assert.ok(gltf.meshes[screen.mesh].primitives[0].attributes.TEXCOORD_0 !== undefined);
  const triangles = gltf.meshes.flatMap((m) => m.primitives).reduce((n, p) => n + gltf.accessors[p.indices].count / 3, 0);
  assert.ok(triangles < 20000, `${triangles} triangles`);
  assert.ok(data.length < 2000000, `${data.length} bytes`);
});

test("companion has eyes, pauses, small excursions and a readable face throughout its loop", () => {
  let pauses = 0, samples = 0, maxExcursion = 0, maxTurn = 0, maxRoll = 0, blinks = 0;
  for (let t = 0; t < ROBOT_IDLE_PERIOD; t += .02) {
    const pose = robotIdlePose(t), next = robotIdlePose(t + .01);
    assert.ok(pose.face, "eyes, not the static logo, are the default idle content");
    assert.ok(Math.abs(pose.yaw + pose.bodyYaw) < .5, "head keeps looking toward the viewer while the chassis turns");
    assert.ok(Math.abs(pose.face.look) <= .12 && Math.abs(pose.face.lookY) <= .08);
    assert.ok(pose.face.blink >= 0 && pose.face.blink <= 1);
    if (Math.hypot(pose.x - next.x, pose.travel - next.travel, pose.bodyYaw - next.bodyYaw) < 1e-9) pauses++;
    if (pose.face.blink > .5) blinks++;
    maxExcursion = Math.max(maxExcursion, Math.hypot(pose.x, pose.travel));
    maxTurn = Math.max(maxTurn, Math.abs(pose.bodyYaw));
    maxRoll = Math.max(maxRoll, Math.abs(pose.roll));
    samples++;
  }
  assert.ok(pauses / samples > .35, "deliberate stops avoid perpetual floating/swaying");
  assert.ok(maxExcursion > .26 && maxExcursion < .272, `${maxExcursion} model units of centre travel`);
  assert.ok(maxTurn > .65 && maxTurn < .7, "visible on-the-spot pivots");
  assert.ok(maxRoll > .1, "a curious articulated head tilt");
  assert.ok(blinks > 20 && blinks < 100);
});

test("motion is deterministic and continuous at every transition and loop boundary", () => {
  const channels = (pose) => [pose.x, pose.travel, pose.bodyYaw, pose.yaw, pose.pitch, pose.roll, ...pose.wheelSpin, ...pose.wheelSteer];
  for (const options of [{}, { focused: true }, { working: true }]) {
    for (let t = 0; t < ROBOT_IDLE_PERIOD + .1; t += .007) {
      const pose = robotIdlePose(t, options);
      const delta = channels(pose).map((value, index) => Math.abs(value - channels(robotIdlePose(t + .0001, options))[index]));
      assert.ok(delta.every((value) => value < .0005), `continuous pose at ${t}`);
      const repeat = channels(robotIdlePose(t + ROBOT_IDLE_PERIOD * 100, options));
      channels(pose).forEach((value, index) => assert.ok(Math.abs(value - repeat[index]) < 1e-9));
    }
    const start = channels(robotIdlePose(0, options)), end = channels(robotIdlePose(ROBOT_IDLE_PERIOD - 1e-6, options));
    start.forEach((value, index) => assert.ok(Math.abs(value - end[index]) < 1e-9, "no reset snap or accumulated wheel roll"));
  }
  assert.deepEqual(robotIdlePose(10), robotIdlePose(10), "sampling has no hidden integration state");
});

test("individual wheel steering and rolling match actual drive and pivot distances", () => {
  const wheelPositions = [[-.635, .395], [.635, .395], [-.635, -.395], [.635, -.395]];
  let forward = false, backward = false, turn = false;
  for (const options of [{}, { focused: true }, { working: true }]) {
    for (let t = 0; t < ROBOT_IDLE_PERIOD; t += .037) {
      const a = robotIdlePose(t, options), b = robotIdlePose(t + .0001, options);
      const angle = (a.bodyYaw + b.bodyYaw) / 2;
      const dx = b.x - a.x, dz = b.travel - a.travel, yaw = b.bodyYaw - a.bodyYaw;
      const localX = Math.cos(angle) * dx - Math.sin(angle) * dz;
      const localZ = Math.sin(angle) * dx + Math.cos(angle) * dz;
      forward ||= localZ > .000001; backward ||= localZ < -.000001; turn ||= Math.abs(yaw) > .00001;
      wheelPositions.forEach(([x, z], index) => {
        const distance = (b.wheelSpin[index] - a.wheelSpin[index]) * ROBOT_WHEEL_RADIUS;
        const steer = (a.wheelSteer[index] + b.wheelSteer[index]) / 2;
        assert.ok(Math.abs(distance * Math.sin(steer) - (localX + yaw * z)) < 1e-9, `wheel ${index} lateral tangent`);
        assert.ok(Math.abs(distance * Math.cos(steer) - (localZ - yaw * x)) < 1e-9, `wheel ${index} rolling tangent`);
      });
    }
  }
  assert.ok(forward && backward && turn, "the loop actually drives, reverses and pivots");
});

test("focus preserves expressions, work reduces travel and reduced motion stays absolutely still", () => {
  let focusedRoll = 0, focusedBlink = 0;
  for (let t = 0; t < ROBOT_IDLE_PERIOD; t += .05) {
    const focused = robotIdlePose(t, { focused: true }), working = robotIdlePose(t, { working: true });
    assert.ok(Math.hypot(focused.x, focused.travel) < .034);
    assert.ok(Math.hypot(working.x, working.travel) < .079);
    focusedRoll = Math.max(focusedRoll, Math.abs(focused.roll));
    focusedBlink = Math.max(focusedBlink, focused.face.blink);
    assert.deepEqual(robotIdlePose(t, { reducedMotion: true, focused: true, working: true, celebrating: true }), robotIdlePose(0, { reducedMotion: true }));
  }
  assert.ok(focusedRoll > .04 && focusedBlink > .8);
  assert.ok(robotIdlePose(5, { celebrating: true }).face.smile > .9);
});

test("head and wheel animation uses real child pivots, not rigid body deformation", () => {
  const root = new Group();
  for (const name of ["head-yaw", "head-pitch", ...["fl", "fr", "rl", "rr"].flatMap((p) => [`wheel-steer-${p}`, `wheel-spin-${p}`])]) {
    const node = new Group(); node.name = name; root.add(node);
  }
  const rig = findRobotRig(root), pose = robotIdlePose(19);
  animateRobotRig(rig, pose);
  assert.equal(rig.yaw.rotation.y, pose.yaw);
  assert.equal(rig.pitch.rotation.x, pose.pitch);
  assert.equal(rig.pitch.rotation.z, pose.roll);
  rig.spin.forEach((node, index) => assert.equal(node.rotation.x, pose.wheelSpin[index]));
  rig.steer.forEach((node, index) => assert.equal(node.rotation.y, pose.wheelSteer[index]));
  assert.equal(root.rotation.y, 0);
});

test("pitch has visible up/down looks and discrete nods, including in close-up", () => {
  for (const options of [{}, { focused: true }, { working: true }]) {
    const rest = robotIdlePose(0, options).pitch;
    const down = robotIdlePose(5.5, options).pitch - rest;
    const up = robotIdlePose(31, options).pitch - rest;
    assert.ok(down >= .21 && down <= .28, "12–16° downward glance");
    assert.ok(up <= -.18 && up >= -.24, "10–14° upward glance");
    assert.ok(robotIdlePose(12.78, options).pitch - rest > .13, "first nod is readable");
    assert.ok(robotIdlePose(13.51, options).pitch - rest > .09, "smaller second nod");
    assert.equal(robotIdlePose(16, options).pitch, rest, "rests instead of continuous bobbing");
  }
});
