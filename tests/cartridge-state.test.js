import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CanvasTextMetrics, Container } from "pixi.js";
import { getHudSafeArea } from "../src/hud-safe-area.js";
import createMeteor, { defaultConfig as meteorConfig } from "../cartridges/meteor-dodge/game.js";
import createPong, { defaultConfig as pongConfig } from "../cartridges/line-pong/game.js";
import createBreakout, { defaultConfig as breakoutConfig } from "../cartridges/quiet-breakout/game.js";

// These Node-only tests check simulation, lifecycle and audio, not typography.
// Real font measurement/rendering is covered by the Chromium cartridge tests.
test.before(() => mock.method(CanvasTextMetrics, "measureText", (value, style) => {
  const lines = String(value).split("\n"), size = Number(style.fontSize) || 16;
  return { width: Math.max(...lines.map(line => line.length)) * size * .6, height: lines.length * size * 1.2 };
}));
test.after(() => mock.restoreAll());

function api(players = 1) {
  return {
    width: 960, height: 540, playerCount: players,
    hudSafeArea: getHudSafeArea(960, 540),
    input: { down: () => false },
    acceptPlayer(player) { if (player !== 2 || this.playerCount !== 1) return false; this.playerCount = 2; return true; },
    endGame(result) { this.result = result; },
  };
}

for (const [id, createGame, defaults] of [["meteor-dodge", createMeteor, meteorConfig], ["line-pong", createPong, pongConfig], ["quiet-breakout", createBreakout, breakoutConfig]]) {
  test(`${id}: persistent user settings remain valid independently of factory defaults`, async () => {
    const config = JSON.parse(await readFile(new URL(`../cartridges/${id}/config.json`, import.meta.url), "utf8"));
    const manifest = JSON.parse(await readFile(new URL(`../cartridges/${id}/game.json`, import.meta.url), "utf8"));
    // Voice/text tuning edits config.json, not the factory's fallback constants.
    // Requiring equality would reject a normal saved user customization.
    assert.deepEqual(Object.keys(config).sort(), Object.keys(defaults).sort());
    assert.doesNotThrow(() => createGame().configure(config));
    assert.equal(manifest.id, createGame().id);
    assert.equal(manifest.stateVersion, createGame().stateVersion);
    assert.equal(manifest.entry, "game.js");
  });

  test(`${id}: snapshot survives a fresh module instance without calling start`, () => {
    const original = createGame();
    const arcade = api();
    original.start(arcade);
    for (let i = 0; i < 10; i += 1) original.update(1 / 60, arcade);
    const state = JSON.parse(JSON.stringify(original.captureState()));
    const replacement = createGame();
    replacement.configure(defaults);
    assert.equal(replacement.restoreState(state, arcade), true);
    assert.deepEqual(replacement.captureState(), state);
    assert.notEqual(replacement.captureState(), state);
    assert.equal(arcade.result, undefined);
  });

  test(`${id}: title, game and results are cartridge-owned disposable scenes`, () => {
    const game = createGame();
    const arcade = api();
    const title = game.renderAttract(arcade, { game, controls: { p1Start: "1", p2Start: "2", exit: "ESC", codex: "C" } });
    assert.ok(title instanceof Container);
    title.destroy({ children: true });
    const scene = game.mount(arcade);
    game.start(arcade);
    game.applyConfig({ background: "#112233" });
    const results = game.renderGameOver(arcade, { result: { score: 456, label: "SCORE", detail: "TEST", leaderboard: [{ name: "P1", score: 456 }] }, controls: {} });
    assert.ok(scene instanceof Container);
    assert.ok(results instanceof Container);
    scene.destroy({ children: true });
    results.destroy({ children: true });
    // A config event can arrive after a scene has been destroyed.
    assert.doesNotThrow(() => game.applyConfig({ background: "#223344" }));
  });

  test(`${id}: malformed updates are rejected atomically`, () => {
    const game = createGame();
    game.start(api());
    const state = game.captureState();
    assert.throws(() => game.restoreState({ ...state, version: 999 }), /incompatible live state/);
    assert.throws(() => game.configure({ background: "red" }), /Invalid color/);
    assert.throws(() => game.configure({ undocumented: 4 }), /Unknown/);
    assert.throws(() => game.configure({ toString: "#000000" }), /Unknown/);
    assert.deepEqual(game.captureState(), state);
  });
}

test("Pong: live speed and paddle edits keep score, ball position and trajectory", () => {
  const game = createPong();
  const arcade = api();
  game.start(arcade);
  const state = game.captureState();
  Object.assign(state, { leftY: 150, rightY: 270, scores: [2, 3], rally: 7, bestRally: 9 });
  Object.assign(state.ball, { x: 380, y: 160, vx: -300, vy: 110 });
  game.restoreState(state, arcade);
  game.applyConfig({ paddleHeight: 160, ballSpeed: 520 });
  const updated = game.captureState();
  assert.deepEqual(updated.scores, [2, 3]);
  assert.equal(updated.leftY, 150);
  assert.equal(updated.rightY, 270);
  assert.equal(updated.ball.x, 380);
  assert.equal(updated.ball.y, 160);
  assert.equal(updated.ball.vx, -600);
  assert.equal(updated.ball.vy, 220);
  assert.equal(updated.rally, 7);
  assert.equal(updated.bestRally, 9);
  const replacement = createPong();
  replacement.configure({ paddleHeight: 160, ballSpeed: 520 });
  replacement.restoreState(updated, arcade);
  assert.deepEqual(replacement.captureState(), updated);
});

test("Pong: enlarged paddle collision uses its new physical size", () => {
  const game = createPong();
  game.start(api());
  game.applyConfig({ paddleHeight: 160 });
  const state = game.captureState();
  state.leftY = 100;
  Object.assign(state.ball, { x: 68, y: 230, vx: -260, vy: 0 });
  game.restoreState(state);
  game.update(1 / 30, api());
  assert.ok(game.captureState().ball.vx > 0);
});

test("Pong: P2 deliberately starts a challenger match, not an accidental hot-reload restart", () => {
  const game = createPong();
  const arcade = api();
  game.start(arcade);
  const state = game.captureState();
  state.scores = [2, 3];
  game.restoreState(state);
  assert.equal(game.onPlayerJoinRequested(2, arcade), true);
  assert.deepEqual(game.captureState().scores, [0, 0]);
  assert.equal(game.captureState().player2Active, true);
  assert.equal(game.onPlayerJoinRequested(2, arcade), false);
});

test("Meteor: P2 joins the live storm and config edits preserve existing entities", () => {
  const game = createMeteor();
  const arcade = api();
  game.start(arcade);
  game.update(0.02, arcade);
  const before = game.captureState();
  game.applyConfig({ meteorSpeed: 460, meteorSize: 36, playerSize: 24 });
  assert.deepEqual(game.captureState(), before);
  assert.equal(game.onPlayerJoinRequested(2, arcade), true);
  const joined = game.captureState();
  assert.equal(joined.elapsed, before.elapsed);
  assert.deepEqual(joined.meteors, before.meteors);
  assert.deepEqual(joined.players[0], before.players[0]);
  assert.equal(joined.players.length, 2);
  game.update(0.02, arcade);
  const after = game.captureState();
  assert.ok(Math.abs(after.meteors[0].y - joined.meteors[0].y - joined.meteors[0].speedFactor * 460 * 0.02) < 1e-8);
});

test("Breakout: a code reload preserves cleared bricks, lives, score and current ball", () => {
  const game = createBreakout();
  game.start(api());
  const state = game.captureState();
  state.bricks[0].alive = false;
  state.lives = 2;
  state.score = 100;
  state.paddleX = 235;
  state.ball.x = 360;
  state.ball.y = 350;
  const replacement = createBreakout();
  replacement.configure({ paddleWidth: 200, ballSpeed: 670 });
  replacement.restoreState(state);
  const restored = replacement.captureState();
  assert.deepEqual(restored.bricks, state.bricks);
  assert.equal(restored.lives, 2);
  assert.equal(restored.score, 100);
  assert.equal(restored.paddleX, 235);
  assert.equal(restored.ball.x, 360);
  assert.equal(restored.ball.y, 350);
  assert.equal(restored.ball.vx, state.ball.vx * 2);
  assert.equal(restored.ball.vy, state.ball.vy * 2);
  assert.equal(replacement.onPlayerJoinRequested(2, api()), false);
});

test("Breakout: larger paddle has a larger collision area immediately", () => {
  const game = createBreakout();
  game.start(api());
  game.applyConfig({ paddleWidth: 220 });
  const state = game.captureState();
  state.paddleX = 200;
  Object.assign(state.ball, { x: 390, y: 465, vx: 0, vy: 335 });
  game.restoreState(state);
  game.update(1 / 60, api());
  assert.ok(game.captureState().ball.vy < 0);
});

const flushAudio = () => new Promise((resolve) => setImmediate(resolve));

function audioApi({ loaded = true, reject = false } = {}) {
  const arcade = api();
  const added = [];
  const played = [];
  arcade.audio = {
    async add(alias, source) {
      added.push({ alias, source });
      if (reject) throw new Error("Offline audio test");
      return { isLoaded: loaded };
    },
    async play(alias, options) { played.push({ alias, options }); return { stop() {} }; },
  };
  return { arcade, added, played };
}

for (const [createGame, count] of [[createMeteor, 2], [createPong, 4], [createBreakout, 3]]) {
  test(`${createGame().id}: sound preload starts only in a live session and runs once`, async () => {
    const game = createGame();
    const { arcade, added, played } = audioApi();
    const scene = game.mount(arcade);
    await flushAudio();
    assert.equal(added.length, 0, "candidate mount is side-effect free");
    game.start(arcade);
    await flushAudio();
    assert.equal(added.length, count);
    for (const { alias, source } of added) {
      assert.match(alias, new RegExp(`^${game.id}:.*\\.ogg$`));
      assert.equal(source.preload, true);
      assert.match(source.url, /^\/assets\/audio\/kenney-digital\//);
    }
    for (let i = 0; i < 4; i += 1) game.update(0.001, arcade);
    await flushAudio();
    assert.equal(added.length, count);
    assert.equal(played.length, 0, "no ambient sound every frame");
    scene.destroy({ children: true });
  });

  test(`${createGame().id}: missing audio never breaks the game`, async () => {
    const game = createGame();
    const { arcade, played } = audioApi({ reject: true });
    const scene = game.mount(arcade);
    game.start(arcade);
    await flushAudio();
    game.update(0.02, arcade);
    await flushAudio();
    assert.equal(played.length, 0);
    scene.destroy({ children: true });
  });
}

test("Pong: loaded collisions and P2 join play separate local sounds", async () => {
  const game = createPong();
  const { arcade, played } = audioApi();
  const scene = game.mount(arcade);
  game.start(arcade);
  await flushAudio();
  const state = game.captureState();
  state.leftY = 100;
  Object.assign(state.ball, { x: 68, y: 130, vx: -260, vy: 0 });
  game.restoreState(state);
  game.update(1 / 30, arcade);
  await flushAudio();
  assert.equal(played[0].alias, "line-pong:tone1.ogg");
  game.onPlayerJoinRequested(2, arcade);
  await flushAudio();
  assert.equal(played[1].alias, "line-pong:threeTone1.ogg");
  scene.destroy({ children: true });
});

test("Pong: deferred collision audio is cancelled when its scene is destroyed", async () => {
  const game = createPong();
  const { arcade, played } = audioApi();
  const scene = game.mount(arcade);
  game.start(arcade);
  await flushAudio();
  const state = game.captureState();
  state.leftY = 100;
  Object.assign(state.ball, { x: 68, y: 130, vx: -260, vy: 0 });
  game.restoreState(state);
  game.update(1 / 30, arcade);
  scene.destroy({ children: true });
  await flushAudio();
  assert.equal(played.length, 0);
});

test("Meteor: a restored replacement preloads audio on its first update without start", async () => {
  const old = createMeteor();
  old.start(api());
  const replacement = createMeteor();
  const { arcade, added, played } = audioApi();
  const scene = replacement.mount(arcade);
  replacement.restoreState(old.captureState());
  await flushAudio();
  assert.equal(added.length, 0);
  replacement.update(0.001, arcade);
  await flushAudio();
  assert.equal(added.length, 2);
  replacement.onPlayerJoinRequested(2, arcade);
  await flushAudio();
  assert.equal(played[0].alias, "meteor-dodge:phaseJump1.ogg");
  scene.destroy({ children: true });
});
