import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { hashCartridge, inspectCartridge, validateCartridge } from "../server/validate-cartridge.js";
import { encodeMidi } from "../src/midi.js";

async function fixture(t, { manifest = {}, code = 'import { Container } from "pixi.js"; export default () => ({ mount: () => new Container() });', config = {} } = {}) {
  // Resolve macOS /var -> /private/var before checking cartridge symlink boundaries.
  const { realpath } = await import("node:fs/promises");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "arcade-validator-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "game.json"), JSON.stringify({ id: "sample-game", title: "Sample", maxPlayers: 1, ...manifest }));
  await writeFile(path.join(directory, "config.json"), JSON.stringify(config));
  await writeFile(path.join(directory, "game.js"), code);
  return directory;
}

test("inspects a cartridge without executing it, and normalizes optional metadata", async (t) => {
  const directory = await fixture(t, { code: 'throw new Error("MUST NOT EXECUTE ON SERVER"); export default () => ({});' });
  const value = await inspectCartridge({ directory, expectedId: "sample-game" });
  assert.equal(value.manifest.entry, "game.js");
  assert.equal(value.manifest.accent, "#fff5a8");
  assert.match(value.revision, /^[a-f0-9]{64}$/);
  assert.equal(value.revision, await hashCartridge(directory));
  assert.ok(!value.report.checked.includes("browser-webgl-smoke"));
});

test("allows existing shared screenshots but not traversals or remote images", async (t) => {
  const directory = await fixture(t, { manifest: { screenshot: "/assets/screenshots/sample.png", liveUpdate: "restart" } });
  assert.equal((await inspectCartridge({ directory })).manifest.screenshot, "/assets/screenshots/sample.png");
  for (const screenshot of ["/assets/../server/code.png", "https://example.com/image.png", "/api/image.png"]) {
    const invalid = await fixture(t, { manifest: { screenshot } });
    await assert.rejects(inspectCartridge({ directory: invalid }), /sans traversée/);
  }
});

test("revision changes for code/assets/config, not documentation", async (t) => {
  const directory = await fixture(t);
  const original = await inspectCartridge({ directory });
  await writeFile(path.join(directory, "BRIEF.md"), "A different artistic direction.");
  assert.equal((await inspectCartridge({ directory })).revision, original.revision);
  await writeFile(path.join(directory, "config.json"), '{"speed":180}');
  assert.notEqual((await inspectCartridge({ directory })).revision, original.revision);
  assert.equal(await readFile(path.join(directory, "config.json"), "utf8"), '{"speed":180}');
});

test("real MIDI soundtrack assets can be published and invalidate the revision when edited", async t => {
  const directory = await fixture(t);
  const before = (await inspectCartridge({ directory })).revision;
  const midi = encodeMidi({ bpm: 90, beats: 4, tracks: [{ notes: [[0, 60, 1]] }] });
  await writeFile(path.join(directory, "soundtrack.mid"), midi);
  const withMusic = (await inspectCartridge({ directory })).revision;
  assert.notEqual(withMusic, before);
  await writeFile(path.join(directory, "ending.midi"), midi);
  assert.notEqual((await inspectCartridge({ directory })).revision, withMusic);
});

test("rejects invalid JSON and changed identity", async (t) => {
  const directory = await fixture(t);
  await assert.rejects(inspectCartridge({ directory, expectedId: "another-game" }), /identifiant/);
  await writeFile(path.join(directory, "config.json"), "{bad}");
  await assert.rejects(inspectCartridge({ directory }), /config.json invalide/);
});

test("rejects symlinks, including links to local files", async (t) => {
  const directory = await fixture(t);
  await symlink(path.join(directory, "game.js"), path.join(directory, "linked.js"));
  await assert.rejects(inspectCartridge({ directory }), /symbolique/);
});

test("rejects sensitive paths and traversing screenshot names", async (t) => {
  const sensitive = await fixture(t);
  await writeFile(path.join(sensitive, ".env"), "EXAMPLE=non-secret");
  await assert.rejects(inspectCartridge({ directory: sensitive }), /non autorisé/);
  const traversing = await fixture(t, { manifest: { screenshot: "../screen.png" } });
  await assert.rejects(inspectCartridge({ directory: traversing }), /sans traversée/);
});

test("rejects imports outside the cartridge and unapproved packages", async (t) => {
  for (const specifier of ["../outside.js", "node:fs", "https://example.com/code.js", "lodash"]) {
    const directory = await fixture(t, { code: `import thing from ${JSON.stringify(specifier)}; export default () => thing;` });
    await assert.rejects(inspectCartridge({ directory }), /Import (?:non autorisé|hors cartouche)/);
  }
});

test("bundles local modules and catches syntax errors", async (t) => {
  const directory = await fixture(t, { code: 'import { value } from "./src/value.js"; export default () => ({value});' });
  await mkdir(path.join(directory, "src"));
  await writeFile(path.join(directory, "src/value.js"), "export const value = 42;");
  assert.equal((await inspectCartridge({ directory })).report.ok, true);
  await writeFile(path.join(directory, "src/value.js"), "export const value = ;");
  await assert.rejects(inspectCartridge({ directory }), /Compilation/);
});

test("rejects computed dynamic imports, including in currently unused modules", async (t) => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, "unused.js"), "export const load = (name) => import(name);");
  await assert.rejects(inspectCartridge({ directory }), /Import calculé interdit/);
  await writeFile(path.join(directory, "unused.js"), 'export const load = () => import("https://example.com/module.js");');
  await assert.rejects(inspectCartridge({ directory }), /Import non autorisé/);
  await writeFile(path.join(directory, "unused.js"), 'export const url = new URL("./own.png", import.meta.url);');
  assert.equal((await inspectCartridge({ directory })).report.ok, true);
});

test("requires a default export and a local browser preview", async (t) => {
  const noDefault = await fixture(t, { code: "export const unused = 1;" });
  await assert.rejects(inspectCartridge({ directory: noDefault }), /factory par défaut/);
  const valid = await fixture(t);
  await assert.rejects(validateCartridge({ directory: valid }), /preview est obligatoire/);
  await assert.rejects(validateCartridge({ directory: valid, previewUrl: "https://example.com/preview.html" }), /localhost/);
});

test("rejects unsupported entries and oversize cartridges", async (t) => {
  const alternate = await fixture(t, { manifest: { entry: "other.js" } });
  await assert.rejects(inspectCartridge({ directory: alternate }), /game.js/);
  const large = await fixture(t);
  await writeFile(path.join(large, "too-large.wav"), Buffer.alloc(20 * 1024 * 1024));
  await assert.rejects(inspectCartridge({ directory: large }), /Budget cartouche/);
});

async function previewServer(t, directory) {
  const project = fileURLToPath(new URL("../", import.meta.url));
  const server = http.createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, "http://127.0.0.1");
      const isCartridge = pathname.startsWith("/preview/test/");
      const base = isCartridge ? directory : project;
      const relative = isCartridge ? pathname.slice("/preview/test/".length) : pathname.slice(1);
      const file = path.resolve(base, relative);
      if (!file.startsWith(`${path.resolve(base)}/`)) throw new Error("outside root");
      const content = await readFile(file);
      response.writeHead(200, { "content-type": ({ ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html", ".json": "application/json" })[path.extname(file)] ?? "application/octet-stream" });
      response.end(content);
    } catch { response.writeHead(404); response.end("Not found"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}/preview.html?session=test`;
}

const browserTestOptions = { skip: process.env.ARCADE_BROWSER_TESTS !== "1", timeout: 30_000 };
for (const id of ["meteor-dodge", "line-pong", "quiet-breakout"]) {
  test(`real Chromium validates published ${id}, including measured HUD and state restoration`, browserTestOptions, async t => {
    const directory = fileURLToPath(new URL(`../cartridges/${id}/`, import.meta.url));
    const previewUrl = await previewServer(t, directory);
    const value = await validateCartridge({ directory, previewUrl, expectedId: id });
    assert.equal(value.report.ok, true);
    assert.ok(value.report.browser.scenarios.every(scenario => scenario.statePreservedOnReplacement));
  });
}
test("real Chromium mounts, updates, preserves state, and renders cartridge screens", browserTestOptions, async (t) => {
  const directory = await fixture(t, { code: `
    import { Container, Graphics } from "pixi.js";
    export default function createGame() {
      let state = { x: 0 }; let actor;
      const screen = () => new Container();
      return {
        stateVersion: 1, configure(apiConfig, arcade) {
          if (arcade.hudSafeArea.left !== 80 || arcade.hudSafeArea.top !== 54 || arcade.hudSafeArea.right !== 880 || arcade.hudSafeArea.bottom !== 486)
            throw new Error("preview-hud-safe-area-missing");
        },
        renderAttract: screen, renderGameOver: screen,
        mount() { const scene = screen(); actor = new Graphics().rect(0, 0, 20, 20).fill(0xffffff); scene.addChild(actor); return scene; },
        start() { state = { x: 0 }; actor.x = 0; },
        update(dt) { state.x += dt; actor.x = state.x; },
        captureState() { return structuredClone(state); },
        restoreState(value) { state = structuredClone(value); actor.x = state.x; return true; }
      };
    }` });
  const previewUrl = await previewServer(t, directory);
  const value = await validateCartridge({ directory, previewUrl, expectedId: "sample-game" });
  assert.equal(value.report.ok, true);
  assert.equal(value.report.browser.ticks, 180);
  assert.match(value.report.browser.screenshot, /^data:image\/png;base64,/);
  assert.equal(value.report.browser.scenarios[0].statePreservedOnReplacement, true);
});

test("real Chromium rejects a cartridge that throws at runtime", browserTestOptions, async (t) => {
  const directory = await fixture(t, { code: 'throw new Error("intentional-browser-failure"); export default () => ({});' });
  const previewUrl = await previewServer(t, directory);
  await assert.rejects(validateCartridge({ directory, previewUrl }), (error) => {
    assert.equal(error.code, "CARTRIDGE_VALIDATION_FAILED");
    assert.ok(error.report.errors.some((item) => item.includes("intentional-browser-failure")));
    return true;
  });
});
