import test from "node:test";
import assert from "node:assert/strict";
import { CabinetPanelState, ReadySand, readyCells, READY_GLYPHS, READY_FILL_SECONDS, READY_CONFIRM_SECONDS } from "../src/cabinet-ready.js";
import { mountCabinetPanel, connectCabinetWorkshop } from "../src/cabinet-panel.js";

const job = (state, sessionId = "one") => ({ sessionId, gameId: "pong", state });
const pub = { sessionId: "one", gameId: "pong", revision: "v2" };

test("READY fills over one minute of real work, but only publication confirms completion", () => {
  const state = new CabinetPanelState();
  state.receive("hub", "voice-activity", { connected: true, inputActive: true }, 0);
  state.receive("hub", "workshop-status", { sessionId: "hub", gameId: null, state: "thinking" }, 0);
  state.receive("hub", "workshop-status", job("ready"), 0);
  assert.equal(state.snapshot(0).fill, 0);
  state.receive("hub", "workshop-status", job("building"), 1);
  const initial = state.snapshot(1);
  assert.equal(initial.working, true);
  assert.equal(initial.fill, 0, "first grains must travel to the bottom before filling");
  assert.ok(state.snapshot(31).fill > .4 && state.snapshot(31).fill < .6);
  const halfway = state.snapshot(31).fill;
  state.receive("game", "workshop-status", job("testing"), 31);
  state.receive("hub", "workshop-status", job("building"), 31);
  assert.equal(state.snapshot(31).fill, halfway, "stage changes and duplicate clients do not reset or jump the timer");
  assert.equal(state.snapshot(1 + READY_FILL_SECONDS).fill, .97);
  assert.equal(state.snapshot(3600).fill, .97, "long work remains visibly unfinished");
  assert.equal(state.snapshot(3600).ready, false);
  state.receive("hub", "game-updated", pub, 62);
  assert.equal(state.snapshot(62).fill, 1);
  assert.equal(state.snapshot(62).celebrate, true);
  state.receive("game", "game-updated", pub, 64);
  assert.equal(state.snapshot(62 + READY_CONFIRM_SECONDS + .1).celebrate, false, "duplicate clients do not restart the confirmation");
  assert.equal(state.snapshot(100).ready, true, "READY stays lit after confirmation");
  state.receive("hub", "workshop-status", job("building"), 101);
  assert.ok(state.snapshot(101).epoch > initial.epoch);
  assert.equal(state.snapshot(101).ready, false);
  assert.equal(state.snapshot(101).fill, 0);
});

test("failure/cancellation never claim completion, and concurrent jobs remain visible", () => {
  const state = new CabinetPanelState();
  state.receive("hub", "workshop-status", job("building"), 0);
  state.receive("hub", "workshop-status", job("testing", "two"), 1);
  state.receive("game", "game-updated", pub, 2);
  assert.equal(state.snapshot(2).working, true);
  assert.equal(state.snapshot(2).ready, false);
  state.receive("hub", "workshop-status", job("error", "two"), 3);
  assert.equal(state.snapshot(3).mode, "error");
  assert.equal(state.snapshot(3).fill, 0);
  state.receive("hub", "workshop-status", job("thinking"), 4);
  assert.equal(state.snapshot(4).fault, false);
  state.receive("hub", "workshop-status", job("idle"), 5);
  assert.equal(state.snapshot(5).mode, "idle");
  state.receive("hub", "game-updated", { gameId: "pong" }, 6);
  assert.equal(state.snapshot(6).ready, false);
});

test("one global pile fills Y then D then A then E then R, never all five at once", () => {
  const sand = new ReadySand();
  const cells = [..."READY"].flatMap((letter, index) => readyCells(letter, index));
  assert.ok(cells.length < 160, "small static DOM, not a canvas simulation");
  const state = { epoch: 1, fill: .46 };
  for (let i = 0; i < 500; i++) sand.update(state, 1 / 24);
  assert.equal(sand.fill, state.fill);
  for (const [tube, letter] of [..."READY"].entries()) {
    const glyph = readyCells(letter, tube);
    for (const cell of glyph) {
      assert.equal(READY_GLYPHS[letter][cell.y][cell.x], "1");
      assert.ok(cell.threshold > 0 && cell.threshold < 1);
      if (sand.light(cell, 0, true) === "settled") {
        for (const lower of cells.filter(p => p.x === cell.x && p.columnY > cell.columnY)) {
          assert.equal(sand.light(lower, 0, true), "settled");
        }
      }
    }
  }
  for (const tube of [3, 4]) assert.ok(cells.filter(c => c.tube === tube).every(c => sand.light(c, 0, true) === "settled"));
  for (const tube of [0, 1]) assert.ok(cells.filter(c => c.tube === tube).every(c => sand.light(c, 0, true) !== "settled"));
  assert.ok(cells.filter(c => c.tube === 2).some(c => sand.light(c, 0, true) === "settled"));
  assert.ok(cells.filter(c => c.tube === 2).some(c => sand.light(c, 0, true) !== "settled"));
  assert.ok(new Set(readyCells("E").filter(c => c.y === 8).map(c => c.threshold)).size > 1);
  let hasGrains = false;
  for (let i = 0; i < 72; i++) hasGrains ||= cells.some(c => sand.light(c, i / 24, true) === "grain");
  assert.ok(hasGrains);
  assert.ok(cells.every(c => ["off", "settled"].includes(sand.light(c, 0, true, true))));
  sand.update({ epoch: 1, fill: 1 }, .01, true);
  assert.ok(cells.every(c => sand.light(c, 0, false) === "settled"));
  sand.update({ epoch: 2, fill: .12 }, 1 / 24);
  assert.ok(sand.fill < .12, "a new creation resets the piles");
});

test("a falling grain crosses every letter in order on one continuous trajectory", () => {
  const sand = new ReadySand(), traversed = new Set();
  let lastY = -Infinity;
  for (let i = 0; i < 240; i++) {
    const grain = sand.grain(0, i / 100);
    if (!grain.visible) continue;
    assert.ok(grain.y >= lastY, "no per-letter teleport or reset");
    lastY = grain.y;
    for (const [tube, letter] of [..."READY"].entries()) {
      if (readyCells(letter, tube).some(c => Math.abs(c.columnY - grain.y) < .012)) traversed.add(tube);
    }
  }
  assert.deepEqual([...traversed], [0, 1, 2, 3, 4]);
  sand.fill = .97;
  assert.equal(sand.grain(0, 1).visible, false, "grains disappear at the existing pile, not through it");
});

function fakeSurface() {
  function element(tagName) {
    return { tagName, className: "", children: [], dataset: {}, attributes: {},
      style: { setProperty(k, v) { this[k] = v; }, getPropertyValue(k) { return this[k] ?? ""; } },
      append(...nodes) { this.children.push(...nodes); },
      set innerHTML(_) { this.grid = element("div"); this.grid.className = "ready-letter"; this.append(this.grid); },
      querySelector(selector) { return selector === ".ready-letter" ? this.grid : null; },
      setAttribute(k, v) { this.attributes[k] = v; }, remove() { this.removed = true; } };
  }
  const media = new Map(), frames = new Map();
  let id = 0, elapsed = 0;
  const host = Object.assign(new EventTarget(), { performance: { now: () => elapsed },
    requestAnimationFrame: callback => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    matchMedia: query => { if (!media.has(query)) media.set(query, Object.assign(new EventTarget(), { matches: false })); return media.get(query); },
  });
  const doc = Object.assign(new EventTarget(), { hidden: false, defaultView: host, createElement: element });
  function step(ms) {
    elapsed += ms;
    const pending = [...frames]; frames.clear();
    for (const [, tick] of pending) tick(elapsed);
  }
  return { host, doc, frames, media, step, cabinet: { ownerDocument: doc, append() {} } };
}

test("CSS panel has no idle loop, shares parent clients and pauses when hidden or reduced", () => {
  const env = fakeSurface(), panel = mountCabinetPanel(env.cabinet);
  const client = new EventTarget();
  const detach = connectCabinetWorkshop(client, { parent: env.host });
  assert.equal(panel.root.tagName, "div");
  assert.equal(panel.root.children.filter(n => n.className === "ready-tube").length, 5);
  assert.equal(panel.root.children.find(n => n.className === "ready-rain").children.length, 10);
  env.step(50);
  assert.equal(env.frames.size, 0, "idle is static");
  const send = (type, detail) => client.dispatchEvent(new CustomEvent(type, { detail }));
  send("workshop-status", job("building"));
  env.step(50);
  assert.equal(panel.root.dataset.mode, "working");
  assert.equal(env.frames.size, 1);
  env.doc.hidden = true; env.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(env.frames.size, 0);
  env.doc.hidden = false; env.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(env.frames.size, 1);
  const portrait = env.media.get("(max-aspect-ratio: 6/5)");
  portrait.matches = true; portrait.dispatchEvent(new Event("change"));
  assert.equal(env.frames.size, 0);
  portrait.matches = false; portrait.dispatchEvent(new Event("change"));
  const reduced = env.media.get("(prefers-reduced-motion: reduce)");
  reduced.matches = true; reduced.dispatchEvent(new Event("change")); env.step(50);
  assert.equal(env.frames.size, 0, "reduced motion is event-driven");
  send("game-updated", pub); env.step(50);
  assert.equal(panel.root.dataset.mode, "ready");
  for (let i = 0; i < 60; i++) env.step(50);
  assert.equal(env.frames.size, 0);
  detach(); send("workshop-status", job("building"));
  assert.equal(env.frames.size, 0);
  panel.dispose();
  assert.equal(env.host.arcadeCabinetPanel, undefined);
  assert.equal(panel.root.removed, true);
});

test("early completion finishes filling, plays one bottom-up confirmation, then stops animating", () => {
  const env = fakeSurface(), panel = mountCabinetPanel(env.cabinet), client = new EventTarget();
  panel.connect(client);
  const send = (type, detail) => client.dispatchEvent(new CustomEvent(type, { detail }));
  send("workshop-status", job("building"));
  for (let i = 0; i < 100; i++) env.step(50);
  send("game-updated", pub);
  env.step(50);
  assert.equal(panel.root.dataset.celebrate, "false", "finish the pile before flashing READY");
  for (let i = 0; i < 26; i++) env.step(50);
  assert.equal(panel.root.dataset.celebrate, "true");
  const tubes = panel.root.children.filter(n => n.className === "ready-tube");
  assert.equal(tubes[4].style.getPropertyValue("--confirm-delay"), "0s");
  assert.ok(parseFloat(tubes[0].style.getPropertyValue("--confirm-delay")) > 0);
  for (let i = 0; i < 60; i++) env.step(50);
  assert.equal(panel.root.dataset.celebrate, "false");
  assert.equal(env.frames.size, 0);
  send("game-updated", pub); env.step(50);
  assert.equal(panel.root.dataset.celebrate, "false");
  assert.equal(env.frames.size, 0);
  panel.dispose();
});
