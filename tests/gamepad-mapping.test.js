import test from "node:test";
import assert from "node:assert/strict";
import { ArcadeInput, loadInputMapping, saveInputMapping } from "../src/input.js";
import { STANDARD_GAMEPAD_MAPPING, PLAYER_ACTIONS, BUTTON_LABELS, CALIBRATION_ACTIONS, REQUIRED_PLAYER_ACTIONS, loadGamepadProfiles, saveGamepadProfile, assignGamepads, readMappedGamepad, activeGamepadBindings } from "../src/gamepad-mapping.js";

const pad = (index = 0, id = "Xbox") => ({ id, index, connected: true, mapping: "standard", buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] });
const profile = (index = 0, id = "Xbox") => ({ id, index, deadzone: .45, actions: structuredClone(STANDARD_GAMEPAD_MAPPING) });
const memory = () => { const data = new Map(); return { getItem: (k) => data.get(k), setItem: (k, v) => data.set(k, v) }; };

test("closing CODEX cannot reopen from the same held USB button after a gameplay reset", () => {
  const target = new EventTarget(), p = pad();
  const input = new ArcadeInput({ target, navigator: { getGamepads: () => [p] }, gamepadProfiles: [null, null] });
  let open = false, toggles = 0;
  target.addEventListener("arcade-system", event => {
    event.preventDefault(); open = !open; toggles++;
    if (!open) input.reset(); // Closing a text/voice menu resets gameplay state.
    input.setMenuBlocked(open);
  });
  const frame = () => { input.beginFrame(); input.endFrame(); };
  try {
    frame(); p.buttons[16].pressed = true; frame();
    assert.equal(open, true);
    p.buttons[16].pressed = false; frame();
    p.buttons[16].pressed = true; frame(); frame(); frame();
    assert.equal(open, false);
    assert.equal(toggles, 2);
    p.buttons[16].pressed = false; frame(); p.buttons[16].pressed = true; frame();
    assert.equal(open, true);
  } finally { input.destroy(); }
});

test("Xbox standard: eight actions, START and both stick/D-pad, no credit action", () => {
  const p = pad();
  for (let i = 0; i < 8; i++) {
    p.buttons[i].pressed = true;
    assert.equal(readMappedGamepad(p).attract, undefined);
    assert.equal(readMappedGamepad(p)["abcdefgh"[i]], true);
    p.buttons[i].pressed = false;
  }
  p.buttons[8].pressed = true;
  assert.equal(readMappedGamepad(p).start, false);
  p.buttons[9].pressed = true;
  p.axes[0] = -.7; p.buttons[12].pressed = true;
  const state = readMappedGamepad(p);
  assert.equal(state.coin, undefined); assert.equal(state.start, true);
  assert.equal(state.left, true); assert.equal(state.up, true);
  assert.equal(state.right, false); assert.equal(state.codex, false);
});

test("analog triggers, axis direction and dead zone remain deterministic", () => {
  const p = pad(); p.buttons[6].value = .8; p.axes[1] = .44;
  assert.equal(readMappedGamepad(p).g, true);
  assert.equal(readMappedGamepad(p).down, false);
  p.axes[1] = .6; assert.equal(readMappedGamepad(p).down, true);
  assert.deepEqual(activeGamepadBindings(p), [{ type: "button", index: 6 }, { type: "axis", index: 1, sign: 1 }]);
});

test("unknown non-standard hardware is calibrated, not guessed", () => {
  const p = pad(); p.mapping = ""; p.buttons[9].pressed = true;
  assert.deepEqual(readMappedGamepad(p), {});
  assert.equal(readMappedGamepad(p, profile()).start, true);
});

test("two identical USB encoders retain P1/P2 assignment after disconnect", () => {
  const profiles = [profile(0, "DragonRise"), profile(1, "DragonRise")];
  const p1 = pad(0, "DragonRise"), p2 = pad(1, "DragonRise");
  assert.deepEqual(assignGamepads([p1, p2], profiles), [p1, p2]);
  assert.deepEqual(assignGamepads([null, p2], profiles), [null, p2]);
  assert.deepEqual(assignGamepads([p1, null], profiles), [p1, null]);
  assert.deepEqual(assignGamepads([null, null, pad(2, "DragonRise")], profiles), [null, null]);
});

test("unique device reconnects at another index without stealing assigned pad", () => {
  const p = pad(3, "Xbox"), second = pad(1, "DragonRise");
  assert.deepEqual(assignGamepads([null, second, null, p], [profile(0), profile(1, "DragonRise")]), [p, second]);
});

test("saved mapping survives reload; duplicate buttons/devices and malformed data rejected", () => {
  const storage = memory(); const p = profile();
  saveGamepadProfile(1, p, storage);
  assert.deepEqual(loadGamepadProfiles(storage), [p, null]);
  assert.throws(() => saveGamepadProfile(2, p, storage), /autre joueur/);
  const duplicate = profile(); duplicate.actions.b = duplicate.actions.a;
  assert.throws(() => saveGamepadProfile(1, duplicate, storage), /déjà attribuée/);
  const missing = profile(); delete missing.actions.h;
  assert.throws(() => saveGamepadProfile(1, missing, storage), /manquant/);
  assert.deepEqual(loadGamepadProfiles({ getItem: () => "broken" }), [null, null]);
  saveGamepadProfile(1, null, storage); assert.deepEqual(loadGamepadProfiles(storage), [null, null]);
});

test("keyboard encoder exposes eight actions and START, without credit keys or collisions", () => {
  const mapping = loadInputMapping({});
  for (const player of [1, 2]) assert.ok(PLAYER_ACTIONS.every((a) => mapping[player][a]));
  const keys = Object.values(mapping).flatMap(Object.values);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(mapping[1].coin, undefined);
  assert.equal(mapping[2].coin, undefined);
  assert.ok(!keys.includes("Digit5") && !keys.includes("Digit6"));
});

test("new keyboard defaults cannot steal a key from a saved legacy mapping", () => {
  const mapping = loadInputMapping({ getItem: () => JSON.stringify({ system: { codex: "KeyQ" }, 1: { start: "Digit5" } }) });
  assert.equal(mapping.system.codex, "KeyQ");
  assert.equal(mapping[1].start, "Digit5");
  assert.equal(mapping[2].f, "");
  assert.equal(mapping[1].coin, undefined);
});

test("calibration labels preserve a-h identities and ask only START/CODEX beyond game buttons", () => {
  assert.deepEqual(Object.keys(BUTTON_LABELS), [..."abcdefgh"]);
  assert.deepEqual(Object.values(BUTTON_LABELS), ["A", "B", "X", "Y", "L1", "R1", "L2", "R2"]);
  assert.deepEqual(CALIBRATION_ACTIONS, ["left", "right", "up", "down", ..."abcdefgh", "start", "codex"]);
  assert.ok(!PLAYER_ACTIONS.includes("coin"));
});

function cabinetProfile(count = 8, index = 0) {
  const p = { id: "DragonRise", index, deadzone: .45, actions: Object.fromEntries([...PLAYER_ACTIONS, "codex", "exit"].map(a => [a, []])) };
  for (const [action, axis, sign] of [["left", 0, -1], ["right", 0, 1], ["up", 1, -1], ["down", 1, 1]])
    p.actions[action] = [{ type: "axis", index: axis, sign }];
  for (const [i, action] of [..."abcdefgh"].entries()) if (i < count) p.actions[action] = [{ type: "button", index: i }];
  p.actions.start = [{ type: "button", index: count }];
  p.actions.codex = [{ type: "button", index: count + 1 }];
  return p;
}

for (const count of [2, 4, 6, 8]) {
  test(`cabinet with ${count} game buttons and two extras saves, reloads and keeps START/CODEX distinct`, () => {
    const storage = memory(), p = cabinetProfile(count), hardware = pad(0, "DragonRise");
    hardware.mapping = "";
    hardware.buttons = Array.from({ length: count + 2 }, () => ({ pressed: false, value: 0 }));
    saveGamepadProfile(1, p, storage);
    const loaded = loadGamepadProfiles(storage)[0];
    assert.deepEqual(loaded, p);
    assert.equal(Object.values(loaded.actions).flat().filter(b => b.type === "button").length, count + 2);
    hardware.buttons[count].pressed = true;
    assert.equal(readMappedGamepad(hardware, loaded).start, true);
    assert.equal(readMappedGamepad(hardware, loaded).codex, false);
    hardware.buttons[count].pressed = false;
    hardware.buttons[count + 1].pressed = true;
    assert.equal(readMappedGamepad(hardware, loaded).start, false);
    assert.equal(readMappedGamepad(hardware, loaded).codex, true);
    assert.equal(readMappedGamepad(hardware, loaded).exit, false);
    assert.equal(readMappedGamepad(hardware, loaded).coin, undefined);
    for (const a of [..."abcdefgh"].slice(count)) assert.equal(readMappedGamepad(hardware, loaded)[a], false);
  });
}

test("skipping actions cannot omit directions/START or assign START and CODEX to the same button", () => {
  for (const action of REQUIRED_PLAYER_ACTIONS) {
    const p = cabinetProfile(); p.actions[action] = [];
    assert.throws(() => saveGamepadProfile(1, p, memory()), /manquant/);
  }
  const p = cabinetProfile(); p.actions.codex = p.actions.start;
  assert.throws(() => saveGamepadProfile(1, p, memory()), /déjà attribuée/);
});

test("legacy COIN bindings are ignored without moving either player's START/CODEX", () => {
  const old = [cabinetProfile(8, 0), cabinetProfile(8, 1)];
  old.forEach(p => { p.actions.coin = [{ type: "button", index: 10 }]; });
  const loaded = loadGamepadProfiles({ getItem: () => JSON.stringify(old) });
  loaded.forEach((p, i) => {
    assert.equal(p.index, i);
    assert.equal(p.actions.coin, undefined);
    assert.deepEqual(p.actions.start, old[i].actions.start);
    assert.deepEqual(p.actions.codex, old[i].actions.codex);
    const hardware = pad(i, "DragonRise"); hardware.buttons[10].pressed = true;
    assert.equal(readMappedGamepad(hardware, old[i]).coin, undefined);
    assert.equal(readMappedGamepad(hardware, p).start, false);
  });
});

test("physical keyboard COIN key can become START; absent actions stay unbound after reload", () => {
  const old = loadInputMapping({}); old[1].coin = "Digit5";
  const mapping = loadInputMapping({ getItem: () => JSON.stringify(old) });
  mapping[1].start = "Digit5";
  mapping[1].g = ""; mapping[1].h = "";
  const storage = memory(); saveInputMapping(mapping, storage);
  const saved = loadInputMapping(storage);
  assert.equal(saved[1].start, "Digit5");
  assert.equal(saved[1].coin, undefined);
  assert.equal(saved[1].g, ""); assert.equal(saved[1].h, "");
  assert.equal(saved.system.codex, "KeyC");
});

test("gamepad CODEX is consumed once and Escape-equivalent cannot also exit the game", () => {
  const target = new EventTarget(), p = pad();
  const input = new ArcadeInput({ target, navigator: { getGamepads: () => [p] }, gamepadProfiles: [null, null] });
  let signals = 0;
  target.addEventListener("arcade-system", (e) => { signals++; e.preventDefault(); });
  input.beginFrame(); input.endFrame();
  p.buttons[16].pressed = true;
  input.beginFrame(); assert.equal(signals, 1); assert.equal(input.systemPressed("codex"), false); input.endFrame();
  input.beginFrame(); assert.equal(signals, 1); input.endFrame();
  p.buttons[11].pressed = true;
  input.beginFrame(); assert.equal(signals, 2); assert.equal(input.systemPressed("exit"), false);
  input.destroy();
});

test("gamepad press edges, focus blocking, disconnect and P2 START stay distinct", () => {
  const target = new EventTarget(), p = pad(1);
  let pads = [null, p];
  const input = new ArcadeInput({ target, navigator: { getGamepads: () => pads }, gamepadProfiles: [null, null] });
  p.buttons[9].pressed = true;
  input.beginFrame(); assert.equal(input.pressed(2, "start"), true); assert.equal(input.pressed(1, "start"), false); input.endFrame();
  input.beginFrame(); assert.equal(input.pressed(2, "start"), false);
  input.setMenuBlocked(true); assert.equal(input.down(2, "start"), false);
  p.buttons[0].pressed = true; input.beginFrame(); assert.equal(input.down(2, "a"), true);
  input.setBlocked(true); input.beginFrame(); assert.equal(input.down(2, "a"), false);
  input.setBlocked(false); pads = []; input.beginFrame(); assert.equal(input.down(2, "a"), false);
  input.destroy();
});
