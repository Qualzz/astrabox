import test from "node:test";
import assert from "node:assert/strict";
import { ArcadeInput } from "../src/input.js";
import { STANDARD_GAMEPAD_MAPPING, loadGamepadProfiles } from "../src/gamepad-mapping.js";
import createMeteor from "../cartridges/meteor-dodge/game.js";
import createPong from "../cartridges/line-pong/game.js";
import createBreakout from "../cartridges/quiet-breakout/game.js";
import { HubCartridge } from "../src/hub-cartridge.js";

// Two indistinguishable USB encoders, including a calibration that assigns J1
// to index 1. Exercise the saved profile -> menu -> fresh game input chain.
for (const slots of [[0, 1], [1, 0]]) test(`configured J1/J2 ${slots} keep their ships across launch, join and restore`, t => {
  const pads = [0, 1].map(index => ({ id: "DragonRise", index, connected: true,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false })), axes: [0, 0] }));
  const profiles = slots.map(index => ({ id: "DragonRise", index, deadzone: .45,
    actions: { ...structuredClone(STANDARD_GAMEPAD_MAPPING), a: [{ type: "button", index: 4 }], e: [{ type: "button", index: 0 }] } }));
  const storage = { getItem: () => JSON.stringify(profiles) };
  const input = () => new ArcadeInput({ target: new EventTarget(), navigator: { getGamepads: () => pads }, gamepadProfiles: loadGamepadProfiles(storage) });
  const menu = input(), gameInput = input();
  t.after(() => { menu.destroy(); gameInput.destroy(); });
  pads[slots[0]].buttons[4].pressed = true;
  menu.beginFrame();
  assert.equal(menu.menuConfirmPlayer(2), 1, "J1 A cannot request two pilots");
  pads[slots[0]].buttons[4].pressed = false;
  const api = { width: 960, height: 540, playerCount: 1, input: gameInput, endGame() {},
    acceptPlayer(player) { if (player !== 2 || this.playerCount !== 1) return false; this.playerCount = 2; return true; } };
  let game = createMeteor();
  game.start(api);
  assert.deepEqual(game.captureState().players.map(p => [p.number, p.x]), [[1, 360]]);
  pads[slots[1]].axes[0] = 1;
  gameInput.beginFrame(); game.update(.02, api); gameInput.endFrame();
  assert.equal(game.captureState().players[0].x, 360, "J2 cannot move the solo J1 ship");
  assert.equal(game.onPlayerJoinRequested(2, api), true);
  for (const restore of [false, true]) {
    if (restore) { const state = game.captureState(); game = createMeteor(); game.restoreState(state, api); }
    for (const player of [1, 2]) {
      pads.forEach(p => { p.axes[0] = 0; });
      pads[slots[player - 1]].axes[0] = 1;
      const before = game.captureState().players;
      gameInput.beginFrame(); game.update(.02, api); gameInput.endFrame();
      const after = game.captureState().players;
      for (const p of [1, 2]) assert.equal(after.find(s => s.number === p).x,
        before.find(s => s.number === p).x + (p === player ? 255 * .02 : 0), `J${player} input, ship ${p}, restored=${restore}`);
    }
  }
});

test("Pong's J1 moves only the left paddle; J2 only the right after joining", () => {
  let active = 1;
  const api = { playerCount: 2, input: { down: (p, a) => p === active && a === "up" }, endGame() {} };
  const game = createPong(); game.start(api);
  for (const player of [1, 2]) {
    active = player;
    const before = game.captureState(); game.update(.01, api); const after = game.captureState();
    assert.equal(after.leftY === before.leftY, player !== 1);
    assert.equal(after.rightY === before.rightY, player !== 2);
  }
});

test("Breakout's solo paddle cannot read J2's directions", () => {
  let active = 2;
  const api = { playerCount: 1, input: { down: (p, a) => p === active && a === "right", pressed: () => false }, endGame() {} };
  const game = createBreakout(); game.start(api);
  const before = game.captureState().paddleX;
  game.update(.01, api);
  assert.equal(game.captureState().paddleX, before);
  active = 1; game.update(.01, api);
  assert.ok(game.captureState().paddleX > before);
});

test("cartridge borrows the exact hub input, keeping its USB source and moving only keyboard ownership", t => {
  const hubWindow = new EventTarget(), gameWindow = new EventTarget();
  const source = { getGamepads: () => [] };
  const input = new ArcadeInput({ target: hubWindow, navigator: source, gamepadProfiles: [null, null] });
  t.after(() => input.destroy());
  const host = Object.assign(Object.create(HubCartridge.prototype), { input, state: "loading", frame: { contentWindow: gameWindow } });
  assert.throws(() => host.acquireInput(new EventTarget()), /contrôles/);
  assert.equal(host.acquireInput(gameWindow), input);
  assert.equal(input.navigator, source, "the game must not enumerate USB devices in a new context");
  input.setEnabled(true);
  const press = target => {
    const e = new Event("keydown", { cancelable: true });
    Object.assign(e, { code: input.mapping[1].a, repeat: false }); target.dispatchEvent(e);
  };
  press(hubWindow); assert.equal(input.pressed(1, "a"), false);
  press(gameWindow); assert.equal(input.pressed(1, "a"), true);
  input.setTarget(hubWindow);
  press(gameWindow); assert.equal(input.pressed(1, "a"), false);
  press(hubWindow); assert.equal(input.pressed(1, "a"), true);
  assert.equal(input.navigator, source);
});
