import { Application } from "pixi.js";
import { ArcadeRuntime } from "./runtime.js";
import { loadCatalog, loadCartridge } from "./cartridge-loader.js";
import { mountWorkshop } from "./workshop-ui.js";
import { initializePixiTextureUnits } from "./pixi-texture-units.js";
import { mountCabinet } from "./cabinet.js";
import { mountCartridgeDisplay } from "./cartridge-display.js";

const params = new URLSearchParams(window.location.search);
const embedded = params.get("embedded") === "1" && window.parent !== window;
document.documentElement.classList.toggle("arcade-embedded", embedded);
const viewport = embedded ? document.querySelector(".cabinet") : mountCabinet();
const notifyHub = (type, detail = {}) => {
  if (embedded) window.parent.postMessage({ type, ...detail }, window.location.origin);
};
const status = document.querySelector("#runtime-status");
try {
  const manifests = await loadCatalog();
  const requested = embedded ? manifests.filter(manifest => manifest.id === params.get("game")) : manifests;
  const loaded = await Promise.allSettled(requested.map((manifest) => loadCartridge(manifest)));
  const games = loaded.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
  for (const entry of loaded) if (entry.status === "rejected") console.error("Cartouche indisponible :", entry.reason);
  if (!games.length) throw new Error("Aucune cartouche disponible.");
  const app = new Application();
  await app.init({
    canvas: document.querySelector("#screen"), width: 960, height: 540, background: 0x000000, backgroundAlpha: 0,
    preference: "webgl", powerPreference: "high-performance", antialias: false,
  });
  initializePixiTextureUnits(app.renderer);
  const fromHub = params.get("from") === "hub";
  const runtime = new ArcadeRuntime(app, status, games, {
    paused: embedded,
    input: embedded ? window.parent.lunarScene.cartridgeHost.acquireInput(window) : null,
    ownsInput: !embedded,
    onExit: embedded ? () => notifyHub("arcade:exit") : fromHub ? () => window.location.assign("/moon.html") : null,
  });
  const display = mountCartridgeDisplay(app, runtime, viewport);
  if (embedded) { app.stop(); runtime.setPaused(true); runtime.input.setEnabled(false); display.present(false); }
  const requestedIndex = games.findIndex((game) => game.id === params.get("game"));
  if (requestedIndex !== -1) {
    runtime.selectedIndex = requestedIndex;
    const players = Number.parseInt(params.get("players") ?? "", 10);
    if (players >= 1) runtime.startGame(players);
    else runtime.showAttract();
  }
  window.arcadeRuntime = runtime;
  window.arcadeWorkshop = mountWorkshop({
    mode: "game",
    getGameContext: () => runtime.captureContext(),
    onGameUpdated: (event) => runtime.reloadGame(event),
    // In-game voice is non-modal: keep movement, actions, replay, P2 START
    // and long-START exit available. Only actual operator typing blocks input.
    onTextFocusChange: (focused) => runtime.input.setBlocked(focused),
    statusInCanvas: true,
    onStatus: (detail) => runtime.setWorkshopStatus(detail),
  });
  if (embedded) {
    let disposed = false;
    const draw = () => app.render();
    window.arcadeEmbedded = {
      canvas: app.canvas, runtime,
      draw,
      activate() {
        display.present(true);
        runtime.input.setEnabled(true);
        // Absorb the launch button that may still be physically held down.
        runtime.input.beginFrame(); runtime.input.endFrame();
        runtime.setPaused(false); draw(); app.start();
      },
      suspend() {
        app.stop(); runtime.setPaused(true); runtime.input.setEnabled(false);
        window.arcadeWorkshop.close(); runtime.audio.stopAll();
        display.present(false); draw();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        app.stop(); window.arcadeWorkshop.dispose(); display.dispose(); runtime.destroy();
        app.destroy(false, { children: true });
      },
    };
    draw();
    notifyHub("arcade:ready", { gameId: runtime.selectedGame.id });
  }
} catch (error) {
  console.error(error);
  status.textContent = `Impossible de lancer le jeu : ${error.message}`;
  notifyHub("arcade:error", { message: error.message });
}
