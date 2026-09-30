import { Application, Assets, Container } from "pixi.js";
import { ArcadeAudio } from "./audio.js";
import { getHudSafeArea } from "./hud-safe-area.js";

const result = window.__cartridgeValidation = { done: false, errors: [], summary: { scenarios: [], ticks: 0, assertions: [] } };
window.addEventListener("unhandledrejection", (event) => result.errors.push(String(event.reason?.message ?? event.reason)));
window.addEventListener("error", (event) => result.errors.push(event.message));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const controls = { p1Start: "ENTER", p2Start: "SPACE", exit: "START 3 SEC", codex: "C", confirm: "A", back: "B" };
const requiredMethods = ["configure", "mount", "start", "update", "captureState", "restoreState", "renderAttract", "renderGameOver"];
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function snapshot(game) {
  const state = game.captureState();
  assert(state != null && typeof state === "object", "captureState() doit renvoyer un état JSON.");
  const encoded = JSON.stringify(state, (_key, value) => {
    assert(!["function", "symbol", "bigint", "undefined"].includes(typeof value), "L’état contient une valeur non sérialisable.");
    assert(typeof value !== "number" || Number.isFinite(value), "L’état contient un nombre non fini.");
    return value;
  });
  assert(encoded.length <= 512 * 1024, "L’état de partie dépasse 512 Kio.");
  return JSON.parse(encoded);
}

async function main() {
  const params = new URLSearchParams(location.search);
  const session = params.get("session"), publishedGame = params.get("game");
  assert(publishedGame ? /^[a-z0-9][a-z0-9-]{0,63}$/.test(publishedGame) : session && /^[a-zA-Z0-9_-]+$/.test(session), "Cible preview invalide.");
  const base = publishedGame ? `/cartridges/${publishedGame}/` : `/preview/${session}/`;
  const loadJson = async (file) => {
    const response = await fetch(base + file);
    assert(response.ok, `${file} : HTTP ${response.status}`);
    return response.json();
  };
  const [manifest, config] = await Promise.all([loadJson("game.json"), loadJson("config.json")]);
  const module = await import(base + (manifest.entry ?? "game.js"));
  assert(typeof module.default === "function", "Export default factory manquant.");
  const app = new Application();
  await app.init({ canvas: document.querySelector("#screen"), width: 960, height: 540, preference: "webgl", antialias: false, autoStart: false });
  app.stop();
  const audio = new ArcadeAudio({ musicActive: false });
  const create = () => {
    const game = module.default();
    for (const method of requiredMethods) assert(typeof game?.[method] === "function", `Méthode obligatoire absente : ${method}`);
    assert(Number.isInteger(game.stateVersion) && game.stateVersion >= 1, "stateVersion doit être un entier positif.");
    if (manifest.maxPlayers === 2) assert(typeof game.onPlayerJoinRequested === "function", "Un jeu 2P doit gérer la demande d’arrivée du joueur 2.");
    return game;
  };
  const show = (container, label) => {
    assert(container instanceof Container && !container.destroyed, `${label} doit renvoyer un Pixi.Container vivant.`);
    app.stage.addChild(container);
    app.render();
    app.stage.removeChild(container);
    container.destroy({ children: true });
  };
  for (const players of manifest.maxPlayers === 2 ? [1, 2] : [1]) {
    let tick = 0;
    let playerCount = players;
    let ended = false;
    let reportedResult = { score: 0, label: "SCORE", detail: "Smoke test", leaderboard: [{ name: "P1", score: 0 }] };
    const input = {
      down: (player, action) => {
        if (player > playerCount) return false;
        const period = Math.floor(tick / 30) % 4;
        return action === ["right", "down", "left", "up"][period] || (action === "a" && tick % 18 < 4);
      },
      pressed: (player, action) => player <= playerCount && action === "a" && tick % 18 === 0,
    };
    const api = { width: 960, height: 540, input, assets: Assets, audio,
      hudSafeArea: getHudSafeArea(960, 540),
      get playerCount() { return playerCount; },
      endGame(value = {}) { ended = true; reportedResult = { ...reportedResult, ...value }; assert(Number.isFinite(reportedResult.score), "Score non fini."); },
      acceptPlayer(player) { if (player !== 2 || playerCount !== 1 || manifest.maxPlayers !== 2) return false; playerCount = 2; return true; },
    };
    let game = create();
    game.configure(structuredClone(config), api);
    show(game.renderAttract(api, { game: manifest, controls }), "renderAttract");
    let scene = game.mount(api);
    assert(scene instanceof Container, "mount() doit renvoyer un Pixi.Container.");
    app.stage.addChild(scene);
    game.start(api);
    snapshot(game);
    for (tick = 0; tick < 180 && !ended; tick += 1) {
      if (players === 1 && manifest.maxPlayers === 2 && tick === 90) game.onPlayerJoinRequested(2, api);
      game.update(1 / 60, api);
      result.summary.ticks += 1;
      if (tick % 30 === 0) { snapshot(game); app.render(); }
    }
    const before = snapshot(game);
    app.render();
    if (players === 1) result.summary.screenshot = document.querySelector("#screen").toDataURL("image/png");
    const replacement = create();
    replacement.configure(structuredClone(config), api);
    const replacementScene = replacement.mount(api);
    assert(replacementScene instanceof Container, "Le remplacement doit monter une scène Pixi.");
    assert(replacement.restoreState(structuredClone(before), api) === true, "restoreState() doit confirmer la restauration avec true.");
    assert(canonical(snapshot(replacement)) === canonical(before), "Le remplacement perd ou modifie l’état courant.");
    app.stage.removeChild(scene);
    game.destroy?.();
    if (!scene.destroyed) scene.destroy({ children: true });
    game = replacement;
    scene = replacementScene;
    app.stage.addChild(scene);
    app.render();
    if (!ended) game.update(1 / 60, api);
    snapshot(game);
    show(game.renderGameOver(api, { result: reportedResult, playerCount, controls }), "renderGameOver");
    // Replay is intentionally a new session; updates above never called start again.
    game.start(api);
    game.update(1 / 60, api);
    snapshot(game);
    app.render();
    app.stage.removeChild(scene);
    game.destroy?.();
    if (!scene.destroyed) scene.destroy({ children: true });
    audio.stopAll();
    result.summary.scenarios.push({ players, ticks: tick, naturalGameOverObserved: ended, playerCountAfterJoinRequest: playerCount, statePreservedOnReplacement: true });
  }
  result.summary.assertions = ["factory-contract", "attract-render", "solo-start", "scripted-input-update", "serializable-finite-state", "same-version-state-restoration", "game-over-render", "replay", "destroy"];
  if (manifest.maxPlayers === 2) result.summary.assertions.push("two-player-start", "join-request-hook");
  // Let rejected asset/audio promises surface; this is not a full-duration gameplay test.
  await new Promise((resolve) => setTimeout(resolve, 120));
  audio.dispose();
  app.destroy(false, { children: true });
}

try { await main(); } catch (error) { result.errors.push(error.stack ?? error.message ?? String(error)); }
finally { result.done = true; }
