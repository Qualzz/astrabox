import test from "node:test";
import assert from "node:assert/strict";
import { ArcadeRuntime, transferLiveState } from "../src/runtime.js";
import { ArcadeInput, loadInputMapping, saveInputMapping } from "../src/input.js";

function game(position = 10, revision = "one") {
  return {
    id: "test-game", revision, config: { speed: 2 }, stateVersion: 1, maxPlayers: 2,
    live: { x: position, score: 42, players: [{ lives: 2 }], elapsed: 5 },
    configure(config) { this.config = config; },
    mount() { return { destroy() {} }; },
    captureState() { return this.live; },
    restoreState(snapshot) { this.live = snapshot; return true; },
  };
}
function runtimeFor(previous) {
  const runtime = Object.create(ArcadeRuntime.prototype);
  Object.assign(runtime, {
    games: [previous], selectedIndex: 0, state: "playing", stateTime: 15,
    playerCount: 2, api: { playerCount: 2 }, reloadSequence: 0,
    input: { controlLabels: {} }, gameLayer: { addChild() {} },
    clearLayers() {}, dismissRestart() {}, showNotice() {},
    offerRestart(next, message) { this.restartCandidate = next; this.reason = message; },
  });
  return runtime;
}

test("live replacement snapshots current state at activation, not job start", async () => {
  const old = game();
  const next = game(0, "two");
  const runtime = runtimeFor(old);
  let loaded;
  runtime.loadGame = () => new Promise((resolve) => { loaded = resolve; });
  const completion = runtime.reloadGame({ gameId: old.id, revision: "two" });
  old.live.x = 200;
  loaded(next);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.selectedGame, old, "module loading must not replace the running game");
  old.live.x = 420;
  old.live.elapsed = 30;
  const pending = runtime.pendingReload;
  pending.resolve(runtime.activateReplacement(pending.game, pending.event));
  assert.deepEqual(await completion, { status: "applied", revision: "two" });
  assert.equal(runtime.selectedGame.live.x, 420);
  assert.equal(runtime.selectedGame.live.elapsed, 30);
  assert.equal(runtime.selectedGame.live.score, 42);
  assert.equal(runtime.stateTime, 15);
  assert.equal(runtime.playerCount, 2);
  assert.notEqual(next.live, old.live, "candidate receives a detached state object");
});

test("incompatible state keeps old game running and asks for restart", () => {
  const old = game();
  const next = game(0, "two");
  next.stateVersion = 2;
  const runtime = runtimeFor(old);
  assert.equal(runtime.activateReplacement(next).status, "restart-required");
  assert.equal(runtime.selectedGame, old);
  assert.equal(runtime.restartCandidate, next);
  assert.equal(old.live.score, 42);
});

test("explicit structural restart request does not silently reset", () => {
  const old = game();
  const next = game();
  const runtime = runtimeFor(old);
  assert.equal(runtime.activateReplacement(next, { requiresRestart: true }).status, "restart-required");
  assert.equal(runtime.selectedGame, old);
});

test("broken configuration or rendering keeps the old game without a misleading restart", () => {
  const old = game();
  for (const method of ["configure", "mount"]) {
    const next = game();
    next[method] = () => { throw new Error("broken cartridge"); };
    const runtime = runtimeFor(old);
    assert.equal(runtime.activateReplacement(next).status, "error");
    assert.equal(runtime.selectedGame, old);
    assert.equal(runtime.restartCandidate, undefined);
  }
});

test("migration receives detached state and preserves newly added fields", () => {
  const old = game();
  const next = game();
  next.stateVersion = 2;
  next.migrateState = (snapshot, version) => {
    assert.equal(version, 1);
    snapshot.dashCooldown = 0;
    return snapshot;
  };
  transferLiveState(old, next, {});
  assert.equal(next.live.dashCooldown, 0);
  assert.equal(next.live.score, 42);
  assert.equal(old.live.dashCooldown, undefined);
});

test("migration rejection cannot mutate the old live state", () => {
  const old = game();
  const next = game();
  next.restoreState = (snapshot) => { snapshot.score = 0; throw new Error("incompatible"); };
  assert.throws(() => transferLiveState(old, next, {}), /incompatible/);
  assert.equal(old.live.score, 42);
});

test("async migration is rejected instead of advancing an incomplete game", () => {
  const old = game();
  const next = game();
  next.stateVersion = 2;
  next.migrateState = async (snapshot) => snapshot;
  assert.throws(() => transferLiveState(old, next, {}), /synchrone/);
});

function key(target, type, code, props = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { code, repeat: false, ...props });
  target.dispatchEvent(event);
  return event;
}
test("arcade mapping persists, rejects collisions, and keeps B separate from exit", () => {
  const values = new Map();
  const storage = { getItem: (name) => values.get(name), setItem: (name, value) => values.set(name, value) };
  const mapping = loadInputMapping(storage);
  mapping.system.codex = "KeyV";
  saveInputMapping(mapping, storage);
  assert.equal(loadInputMapping(storage).system.codex, "KeyV");
  mapping.system.codex = "Enter";
  assert.throws(() => saveInputMapping(mapping, storage), /différente/);
  const target = new EventTarget();
  const input = new ArcadeInput({ target, navigator: {}, mapping: loadInputMapping(storage) });
  key(target, "keydown", "KeyL");
  assert.equal(input.pressed(1, "b"), true);
  assert.equal(input.systemPressed("exit"), false);
  input.destroy();
});

test("CODEX is emitted once, consuming Escape does not also exit the game", () => {
  const target = new EventTarget();
  const input = new ArcadeInput({ target, navigator: {}, mapping: loadInputMapping({}) });
  let signals = 0;
  target.addEventListener("arcade-system", (event) => { signals += 1; event.preventDefault(); });
  key(target, "keydown", "KeyC");
  key(target, "keydown", "KeyC", { repeat: true });
  assert.equal(signals, 1);
  key(target, "keydown", "Escape");
  assert.equal(input.systemPressed("exit"), false);
  input.destroy();
  key(target, "keydown", "KeyC");
  assert.equal(signals, 2, "destroy removes the only keyboard source");
});

test("text focus blocks play, menu focus only blocks START", () => {
  const target = new EventTarget();
  const input = new ArcadeInput({ target, navigator: {}, mapping: loadInputMapping({}) });
  input.setMenuBlocked(true);
  key(target, "keydown", "Enter");
  key(target, "keydown", "ArrowRight");
  assert.equal(input.pressed(1, "start"), false);
  assert.equal(input.down(1, "right"), true);
  input.setBlocked(true);
  key(target, "keydown", "ArrowRight");
  assert.equal(input.down(1, "right"), false);
  input.destroy();
});
