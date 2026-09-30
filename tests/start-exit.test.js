import test from "node:test";
import assert from "node:assert/strict";
import { ArcadeInput, loadInputMapping, START_EXIT_HOLD_MS } from "../src/input.js";
import { ArcadeRuntime } from "../src/runtime.js";

function fixture(t, options = {}) {
  const target = new EventTarget();
  const mapping = loadInputMapping({});
  mapping[1].start = "Digit5"; // Real cabinet's physical COIN -> START mapping.
  const input = new ArcadeInput({ target, mapping, navigator: {}, gamepadProfiles: [null, null], ...options });
  t.after(() => input.destroy());
  const key = (type, player) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { code: mapping[player].start, repeat: false });
    target.dispatchEvent(event);
  };
  return { input, target, key };
}

for (const player of [1, 2]) test(`START P${player}: immediate short edge, exit at 3000 ms, once per hold`, t => {
  const { input, key } = fixture(t);
  key("keydown", player);
  assert.equal(input.pressed(player, "start"), true);
  assert.equal(input.startHeldForExit(100), false);
  assert.equal(input.startExitHoldProgress, 0);
  input.endFrame();
  assert.equal(input.pressed(player, "start"), false);
  assert.equal(input.startHeldForExit(3099), false);
  assert.equal(input.startExitHoldProgress, 2999 / 3000);
  assert.equal(input.startHeldForExit(3100), true);
  assert.equal(input.startExitHoldProgress, 1);
  assert.equal(input.startHeldForExit(9000), false);
  key("keyup", player);
  assert.equal(input.startExitHoldProgress, null);
  key("keydown", player); // Even when release/repress occurs between frames.
  assert.equal(input.startHeldForExit(9100), false);
  assert.equal(input.startHeldForExit(12100), true);
  assert.equal(START_EXIT_HOLD_MS, 3000);
  assert.equal(input.controlLabels.exit, "START 3 SEC");
});

test("separate attempts and different players cannot accumulate a hold", t => {
  const { input, key } = fixture(t);
  key("keydown", 1); input.startHeldForExit(0);
  assert.equal(input.startHeldForExit(2500), false);
  key("keyup", 1); key("keydown", 1);
  assert.equal(input.startHeldForExit(2600), false);
  key("keydown", 2); input.startHeldForExit(4000);
  key("keyup", 1);
  assert.equal(input.startHeldForExit(5600), false);
  assert.equal(input.startExitHoldProgress, 1600 / 3000);
  assert.equal(input.startHeldForExit(7000), true);
});

for (const block of ["blur", "text", "workshop", "mapping"]) test(`${block} cancels a pending START hold`, t => {
  const { input, key, target } = fixture(t);
  key("keydown", 1); input.startHeldForExit(0);
  if (block === "blur") target.dispatchEvent(new Event("blur"));
  if (block === "text") input.setBlocked(true);
  if (block === "workshop") input.setMenuBlocked(true);
  if (block === "mapping") input.onMappingChange();
  assert.equal(input.startHeldForExit(5000), false);
  assert.equal(input.startExitHoldProgress, null);
  if (block === "blur") target.dispatchEvent(new Event("focus"));
  if (block === "text") input.setBlocked(false);
  if (block === "workshop") input.setMenuBlocked(false);
  if (block === "mapping") input.mapping[1].start = "Digit5";
  key("keydown", 1);
  assert.equal(input.startHeldForExit(6000), false);
  assert.equal(input.startHeldForExit(8999), false);
  assert.equal(input.startHeldForExit(9000), true);
});

test("mapped USB START supports long exit and disconnect cancels it", t => {
  const pad = { id: "Arcade USB", index: 1, connected: true, mapping: "", axes: [], buttons: [{ pressed: true }] };
  let pads = [null, pad];
  const { input } = fixture(t, {
    navigator: { getGamepads: () => pads },
    gamepadProfiles: [null, { id: pad.id, index: 1, actions: { start: [{ type: "button", index: 0 }] } }],
  });
  input.beginFrame();
  assert.equal(input.pressed(2, "start"), true);
  input.startHeldForExit(0); input.endFrame();
  pads = []; input.beginFrame();
  assert.equal(input.startHeldForExit(3500), false);
  assert.equal(input.startExitHoldProgress, null);
  pads = [null, pad]; input.beginFrame();
  assert.equal(input.startHeldForExit(4000), false);
  assert.equal(input.startHeldForExit(7000), true);
});

test("disabling input clears the visible hold immediately", t => {
  const { input, key } = fixture(t);
  key("keydown", 1); input.startHeldForExit(0); input.startHeldForExit(1500);
  assert.equal(input.startExitHoldProgress, .5);
  input.setEnabled(false);
  assert.equal(input.startExitHoldProgress, null);
  assert.equal(input.startHeldForExit(5000), false);
});

test("runtime START remains immediate for solo/join, long hold exits even with a restart proposal", t => {
  const { input, key } = fixture(t);
  let exits = 0, starts = 0, joins = 0, dismissed = 0, now = 0;
  const hold = input.startHeldForExit.bind(input);
  input.startHeldForExit = () => hold(now);
  const runtime = Object.create(ArcadeRuntime.prototype);
  Object.assign(runtime, {
    input, state: "attract", stateTime: 0, noticeTime: 0, selectedIndex: 0, playerCount: 0,
    api: {}, gameLayer: { addChild() {} }, audio: { stopAll() {}, setMusicActive() {} },
    games: [{ maxPlayers: 2, configure() {}, mount() {}, start() { starts++; }, update() {},
      onPlayerJoinRequested() { joins++; runtime.playerCount = 2; return true; } }],
    crtFilter: { resources: { crtUniforms: { uniforms: { uTime: 0 } } } },
    clearLayers() {}, updateStatus() {}, onExit() { exits++; },
    dismissRestart() { dismissed++; this.restartCandidate = null; },
  });
  key("keydown", 1); runtime.frame(.016);
  assert.equal(starts, 1); assert.equal(runtime.playerCount, 1); assert.equal(exits, 0);
  key("keyup", 1); runtime.frame(.016);
  key("keydown", 2); now = 100; runtime.frame(.016);
  assert.equal(joins, 1); assert.equal(runtime.playerCount, 2);
  key("keyup", 2); runtime.frame(.016);
  key("keydown", 1); now = 200; runtime.frame(.016);
  runtime.restartCandidate = {};
  now = 3199; runtime.frame(.016); assert.equal(exits, 0);
  now = 3200; runtime.frame(.016); assert.equal(exits, 1); assert.equal(dismissed, 1);
  now = 10000; runtime.frame(.016); assert.equal(exits, 1);
});
