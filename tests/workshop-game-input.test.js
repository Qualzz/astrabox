import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chromium } from "playwright";
import { createArcadeServer } from "../server/index.js";

test("in-game Codex is non-modal: keyboard/USB actions, replay, P2 join and exit remain available", {
  skip: process.env.ARCADE_BROWSER_TESTS !== "1", timeout: 45_000,
}, async t => {
  // Serve the real main.js/runtime/UI and published cartridges, but never
  // initialize Codex or request a real microphone. Browser storage is isolated.
  const workshop = Object.assign(new EventEmitter(), {
    sessions: new Map(), initialize: async () => {}, close: async () => {},
  });
  const app = await createArcadeServer({ port: 0, workshop });
  const address = await app.listen();
  t.after(() => new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); }));
  const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [], writes = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", route => {
    if (route.request().method() === "GET") return route.continue();
    writes.push(route.request().url());
    return route.abort();
  });
  const origin = `http://127.0.0.1:${address.port}`;
  const load = async (gameId, debug = false) => {
    await page.goto(`${origin}/index.html?game=${gameId}&players=1&from=hub${debug ? "&debug=1" : ""}`);
    await page.waitForFunction(() => window.arcadeRuntime && window.arcadeWorkshop);
    await page.evaluate(() => {
      const c = window.arcadeWorkshop.client;
      window.__voiceStarts = 0;
      c.startVoice = async () => { window.__voiceStarts++; c.voiceStarting = true; c._status("connecting"); };
      c.stopVoice = async () => { c.voiceStarting = false; c._status("idle"); };
      window.__pads = [0, 1].map(index => ({ id: `Test pad ${index}`, index, connected: true,
        mapping: "standard", axes: [0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }));
      Object.defineProperty(navigator, "getGamepads", { configurable: true, value: () => window.__pads });
    });
  };
  await load("quiet-breakout", true);
  assert.equal(await page.locator(".workshop-switch").count(), 0, "operator mode also uses the mapped CODEX action");
  await page.keyboard.press("c");
  assert.deepEqual(await page.evaluate(() => ({
    open: window.arcadeWorkshop.isOpen, voice: window.arcadeWorkshop.client.voiceActive,
    menuBlocked: window.arcadeRuntime.input.menuBlocked, blocked: window.arcadeRuntime.input.blocked,
  })), { open: true, voice: true, menuBlocked: false, blocked: false });

  for (const state of ["connecting", "listening", "speaking", "building", "error"]) {
    const x = await page.evaluate(state => {
      window.arcadeWorkshop.client._status(state);
      return window.arcadeRuntime.selectedGame.captureState().paddleX;
    }, state);
    const key = x > 450 ? "ArrowLeft" : "ArrowRight";
    await page.keyboard.down(key);
    await page.waitForFunction(x => Math.abs(window.arcadeRuntime.selectedGame.captureState().paddleX - x) > 8, x);
    await page.keyboard.up(key);
    assert.equal(await page.evaluate(() => window.arcadeWorkshop.isOpen), true);
  }

  // A/B remain ordinary game actions, not confirmation/close for the voice UI.
  for (const [key, action] of [["k", "a"], ["l", "b"]]) {
    await page.keyboard.down(key);
    assert.equal(await page.evaluate(action => window.arcadeRuntime.input.down(1, action), action), true);
    assert.equal(await page.evaluate(() => window.arcadeWorkshop.isOpen), true);
    await page.keyboard.up(key);
  }
  await page.evaluate(() => { window.arcadeRuntime.endGame({ score: 0 }); window.arcadeRuntime.stateTime = 1; });
  await page.keyboard.press("k");
  await page.waitForFunction(() => window.arcadeRuntime.state === "playing");
  assert.equal(await page.evaluate(() => window.arcadeWorkshop.isOpen && window.arcadeWorkshop.client.voiceActive), true);
  assert.equal(await page.evaluate(() => window.__voiceStarts), 1, "replay must not restart the voice conversation");

  // Only actual typing blocks game input. Blurring resumes it without closing Codex.
  await page.locator("textarea").focus();
  assert.equal(await page.evaluate(() => window.arcadeRuntime.input.blocked), true);
  await page.keyboard.press("k");
  assert.equal(await page.locator("textarea").inputValue(), "k");
  await page.locator("textarea").evaluate(element => element.blur());
  assert.equal(await page.evaluate(() => window.arcadeRuntime.input.blocked), false);
  assert.equal(await page.evaluate(() => window.arcadeWorkshop.isOpen), true);

  await load("meteor-dodge");
  assert.equal(await page.locator(".workshop-switch").count(), 0, "no duplicate CODEX button on a cartridge");
  // Actual mapped USB polling path (synthetic pads), including CODEX held across frames.
  await page.evaluate(() => { window.__pads[0].axes[0] = 1; window.__pads[0].buttons[16].pressed = true; });
  await page.waitForFunction(() => window.arcadeWorkshop.isOpen && window.arcadeRuntime.input.down(1, "right"));
  assert.equal(await page.locator(".workshop-switch").count(), 0, "opening voice must not restore the duplicate button");
  await page.waitForFunction(() => window.arcadeRuntime.selectedGame.captureState().players[0].x > 375);
  assert.equal(await page.evaluate(() => window.__voiceStarts), 1);
  await page.evaluate(() => { window.__pads[0].axes[0] = 0; window.__pads[0].buttons[16].pressed = false; window.__pads[1].buttons[9].pressed = true; });
  await page.waitForFunction(() => window.arcadeRuntime.playerCount === 2);
  await page.evaluate(() => { window.__pads[1].buttons[9].pressed = false; window.__pads[1].axes[0] = -1; });
  await page.waitForFunction(() => window.arcadeRuntime.selectedGame.captureState().players.find(p => p.number === 2).x < 590);
  assert.equal(await page.evaluate(() => window.arcadeWorkshop.isOpen), true);
  await page.evaluate(() => { window.__pads[1].axes[0] = 0; window.__pads[0].buttons[16].pressed = true; });
  await page.waitForFunction(() => !window.arcadeWorkshop.isOpen && !window.arcadeWorkshop.client.voiceActive);
  await page.evaluate(() => { window.__pads[0].buttons[16].pressed = false; });
  await page.keyboard.press("c");
  assert.equal(await page.evaluate(() => window.arcadeWorkshop.isOpen), true);

  // Holding START exits even with voice open; a single short START still joins.
  await page.keyboard.down("Enter");
  await page.waitForURL("**/moon.html");
  await page.keyboard.up("Enter");
  await page.waitForFunction(() => window.lunarScene?.workshop);
  assert.equal(await page.locator(".workshop-switch").count(), 0, "the hub has no clickable CODEX launcher either");
  await page.keyboard.press("c");
  assert.equal(await page.evaluate(() => window.lunarScene.view), "robot", "mapped CODEX still focuses the robot");
  assert.equal(await page.evaluate(() => window.arcadeWorkshop.client.voiceActive), false, "focusing the robot alone must not open the microphone");
  await page.keyboard.press("c");
  assert.equal(await page.evaluate(() => window.lunarScene.view), "games", "mapped CODEX still toggles back to the games");
  assert.deepEqual(writes, [], "the test must never send a real Codex request");
  assert.deepEqual(errors, []);
});
