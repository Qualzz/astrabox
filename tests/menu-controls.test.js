import test from "node:test";
import assert from "node:assert/strict";
import { ArcadeInput, loadInputMapping } from "../src/input.js";
import { ArcadeRuntime } from "../src/runtime.js";

function setup(t) {
  const target = new EventTarget();
  const input = new ArcadeInput({ target, navigator: {}, mapping: loadInputMapping({}), gamepadProfiles: [null, null] });
  t.after(() => input.destroy());
  const press = (player, action) => {
    const event = new Event("keydown", { cancelable: true });
    Object.assign(event, { code: input.mapping[player][action], repeat: false });
    target.dispatchEvent(event);
  };
  return { input, press };
}

for (const player of [1, 2]) test(`A P${player} confirms solo and multiplayer menus without START`, t => {
  const { input, press } = setup(t);
  press(player, "a");
  assert.equal(input.menuConfirmPlayer(1), 1);
  assert.equal(input.menuConfirmPlayer(2), player);
  assert.equal(input.menuConfirmPlayer(2, 2), 2, "replay preserves two players");
  assert.equal(input.pressed(player, "start"), false, "A must not become gameplay START");
  input.endFrame();
  assert.equal(input.menuConfirmPlayer(2), 0, "holding does not repeatedly confirm");
});

test("START retains solo/2P meaning and B is not a system exit", t => {
  const { input, press } = setup(t);
  press(2, "start");
  assert.equal(input.menuConfirmPlayer(1), 0);
  assert.equal(input.menuConfirmPlayer(2), 2);
  input.endFrame(); press(1, "start");
  assert.equal(input.menuConfirmPlayer(1), 1);
  input.endFrame(); press(2, "b");
  assert.equal(input.menuBackPressed(), true);
  assert.equal(input.systemPressed("exit"), false);
  assert.equal(input.down(2, "b"), true);
});

test("explicit menu locks and text focus block menu aliases, without consuming gameplay A/B", t => {
  const { input, press } = setup(t);
  input.setMenuBlocked(true); press(1, "a"); press(2, "b");
  assert.equal(input.menuConfirmPlayer(2), 0);
  assert.equal(input.menuBackPressed(), false);
  assert.equal(input.down(1, "a"), true);
  input.setBlocked(true);
  assert.equal(input.menuConfirmPlayer(2), 0);
  assert.equal(input.menuBackPressed(), false);
});

test("USB A/B aliases use the saved calibration, not hardcoded standard button indexes", t => {
  const { input } = setup(t);
  input.gamepadProfiles = [{ id: "Arcade", index: 0, deadzone: .45, actions: {
    a: [{ type: "button", index: 4 }], b: [{ type: "button", index: 2 }], start: [{ type: "button", index: 9 }],
  } }, null];
  const buttons = Array.from({ length: 10 }, () => ({ pressed: false }));
  input.navigator = { getGamepads: () => [{ id: "Arcade", index: 0, connected: true, buttons, axes: [] }] };
  buttons[4].pressed = true; input.beginFrame();
  assert.equal(input.menuConfirmPlayer(1), 1);
  input.endFrame(); buttons[4].pressed = false; buttons[2].pressed = true; input.beginFrame();
  assert.equal(input.menuConfirmPlayer(1), 0);
  assert.equal(input.menuBackPressed(), true);
});

test("runtime uses A/B in title/results, but keeps B and A as gameplay actions", t => {
  const { input, press } = setup(t);
  const runtime = Object.create(ArcadeRuntime.prototype);
  let starts = [], exits = 0, joins = 0, gameTicks = 0;
  Object.assign(runtime, {
    input, games: [{ maxPlayers: 2, update() { gameTicks++; }, onPlayerJoinRequested() { joins++; return true; } }],
    selectedIndex: 0, stateTime: 2, playerCount: 2,
    startGame(players) { starts.push(players); }, returnToAttract() { exits++; },
  });
  press(1, "a"); runtime.updateAttract(.016);
  assert.deepEqual(starts, [1]); input.endFrame();
  press(2, "b"); runtime.updateAttract(.016);
  assert.equal(exits, 1); input.endFrame();
  press(1, "a"); runtime.updateGameOver(.016);
  assert.deepEqual(starts, [1, 2]); input.endFrame();
  press(1, "b"); runtime.updateGameOver(.016);
  assert.equal(exits, 2); input.endFrame();
  runtime.playerCount = 1; press(2, "a"); press(1, "b"); runtime.updatePlaying(.016);
  assert.equal(gameTicks, 1); assert.equal(exits, 2); assert.equal(joins, 0);
  input.endFrame(); press(2, "start"); runtime.updatePlaying(.016);
  assert.equal(joins, 1);
});

test("a menu confirmation is not replayed as a gameplay A edge on the same tick", t => {
  const { input, press } = setup(t);
  const runtime = Object.create(ArcadeRuntime.prototype);
  let shots = 0;
  Object.assign(runtime, {
    input, state: "attract", stateTime: 0, noticeTime: 0, playerCount: 1, selectedIndex: 0,
    games: [{ maxPlayers: 1, update() { if (input.pressed(1, "a")) shots++; } }],
    crtFilter: { resources: { crtUniforms: { uniforms: { uTime: 0 } } } },
    startGame() { this.state = "playing"; }, updateStatus() {},
  });
  press(1, "a"); runtime.frame(.016); runtime.frame(.016);
  assert.equal(runtime.state, "playing");
  assert.equal(shots, 0);
  press(1, "a"); runtime.frame(.016);
  assert.equal(shots, 1);
});
