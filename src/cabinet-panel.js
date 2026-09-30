import { CabinetPanelState, ReadySand, readyCells, READY_CONFIRM_SECONDS } from "./cabinet-ready.js";
export { CabinetPanelState } from "./cabinet-ready.js";

export const PANEL_RECT = Object.freeze({ x: 1414, y: 90, width: 102, height: 648 });
const EVENTS = ["workshop-status", "game-updated"];
const LABELS = { idle: "En attente d’une création", thinking: "Préparation du jeu", building: "Création du jeu",
  working: "Création du jeu", testing: "Vérification du jeu", applying: "Publication du jeu",
  ready: "READY — jeu publié", error: "Création interrompue — consultez le robot" };

export function mountCabinetPanel(cabinet) {
  const doc = cabinet.ownerDocument, host = doc.defaultView;
  const root = doc.createElement("div");
  root.className = "crt-instruments ready-tubes";
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-atomic", "true");
  Object.assign(root.style, { left: `${PANEL_RECT.x / 1672 * 100}%`, top: `${PANEL_RECT.y / 941 * 100}%`,
    width: `${PANEL_RECT.width / 1672 * 100}%`, height: `${PANEL_RECT.height / 941 * 100}%` });
  const caption = doc.createElement("span");
  caption.className = "ready-accessible";
  root.append(caption);
  const leds = [], tubes = [];
  for (const [index, letter] of [..."READY"].entries()) {
    const tube = doc.createElement("div");
    tube.className = "ready-tube";
    tube.style.setProperty("--confirm-delay", `${(4 - index) * .13}s`);
    tube.setAttribute("aria-hidden", "true");
    tube.innerHTML = `<i class="ready-tip"></i><i class="ready-pins"></i><i class="ready-socket"></i>
      <div class="ready-glass"><i class="ready-anode"></i><div class="ready-letter"></div><i class="ready-reflection"></i></div>`;
    const grid = tube.querySelector(".ready-letter");
    for (const cell of readyCells(letter, index)) {
      const node = doc.createElement("i");
      node.className = "ready-led";
      node.dataset.light = "off";
      node.style.left = `${cell.x / 4 * 100}%`;
      node.style.top = `${cell.y / 8 * 100}%`;
      grid.append(node);
      leds.push({ node, cell, light: "off" });
    }
    tubes.push(tube);
    root.append(tube);
  }
  // Ten tiny CSS grains travel across the entire word, including the gaps.
  // Only glyph LEDs accumulate; there is no rectangle filling behind them.
  const rain = doc.createElement("div"), grains = [];
  rain.className = "ready-rain";
  rain.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 10; index++) {
    const grain = doc.createElement("i");
    grain.className = "ready-grain";
    grain.style.left = `${28.38 + index % 5 * 10.81}%`;
    rain.append(grain);
    grains.push(grain);
  }
  root.append(rain);
  cabinet.append(root);
  const state = new CabinetPanelState(), sand = new ReadySand(), subscriptions = new Map();
  const portrait = host.matchMedia("(max-aspect-ratio: 6/5)");
  const reduced = host.matchMedia("(prefers-reduced-motion: reduce)");
  const now = () => host.performance.now() / 1000;
  let frame = null, previous = null, disposed = false, lastPhase = "";
  let confirmedPublication = -Infinity, confirmUntil = -Infinity;
  const visible = () => !disposed && !doc.hidden && !portrait.matches;

  function wake() {
    if (visible() && frame === null) frame = host.requestAnimationFrame(tick);
  }
  function tick(ms) {
    frame = null;
    if (!visible()) return;
    const elapsed = ms / 1000;
    const dt = previous === null ? 1 / 24 : elapsed - previous;
    if (dt < 1 / 24) { wake(); return; }
    previous = elapsed;
    const snapshot = state.snapshot(elapsed);
    const fill = sand.update(snapshot, dt, reduced.matches);
    if (root.dataset.mode !== snapshot.mode) root.dataset.mode = snapshot.mode;
    if (!snapshot.ready) confirmUntil = -Infinity;
    if (snapshot.ready && fill >= .9999 && confirmedPublication !== state.completedAt) {
      confirmedPublication = state.completedAt;
      confirmUntil = reduced.matches ? -Infinity : elapsed + READY_CONFIRM_SECONDS;
    }
    const celebrating = elapsed < confirmUntil && !reduced.matches;
    if (root.dataset.celebrate !== String(celebrating)) root.dataset.celebrate = String(celebrating);
    if (snapshot.phase !== lastPhase) {
      lastPhase = snapshot.phase;
      caption.textContent = LABELS[snapshot.phase];
      root.setAttribute("aria-label", LABELS[snapshot.phase]);
    }
    const lit = [0, 0, 0, 0, 0], total = [0, 0, 0, 0, 0];
    for (const led of leds) {
      const light = sand.light(led.cell, snapshot.age, snapshot.working, reduced.matches);
      total[led.cell.tube]++;
      if (light === "settled") lit[led.cell.tube]++;
      if (led.light !== light) { led.node.dataset.light = led.light = light; }
    }
    for (const [index, tube] of tubes.entries()) {
      const energy = (snapshot.fault ? .08 : lit[index] / total[index] * .85 + (snapshot.working ? .04 : 0)).toFixed(2);
      if (tube.style.getPropertyValue("--energy") !== energy) tube.style.setProperty("--energy", energy);
    }
    for (const [index, node] of grains.entries()) {
      const grain = sand.grain(index, snapshot.age);
      const opacity = snapshot.working && !reduced.matches && grain.visible ? "1" : "0";
      if (node.style.opacity !== opacity) node.style.opacity = opacity;
      if (opacity === "1") node.style.transform = `translateY(${(grain.y * 100).toFixed(2)}%)`;
    }
    // Zero idle RAFs. No canvas, full-screen filter, audio analyser or polling.
    if (Math.abs(fill - snapshot.fill) > .0001 || celebrating || (snapshot.working && !reduced.matches)) wake();
    else previous = null;
  }
  function visibility() {
    if (frame !== null) host.cancelAnimationFrame(frame);
    frame = null; previous = null;
    wake();
  }
  const api = {
    root, state,
    connect(client) {
      if (disposed) return () => {};
      if (subscriptions.has(client)) return subscriptions.get(client);
      const handlers = EVENTS.map(type => {
        const handler = event => { state.receive(client, type, event.detail, now()); wake(); };
        client.addEventListener(type, handler);
        return [type, handler];
      });
      for (const detail of client.workshopStates?.values() ?? []) state.receive(client, "workshop-status", detail, now());
      const detach = () => {
        for (const [type, handler] of handlers) client.removeEventListener(type, handler);
        subscriptions.delete(client);
      };
      subscriptions.set(client, detach);
      wake();
      return detach;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== null) host.cancelAnimationFrame(frame);
      for (const detach of [...subscriptions.values()]) detach();
      doc.removeEventListener("visibilitychange", visibility);
      portrait.removeEventListener("change", visibility);
      reduced.removeEventListener("change", visibility);
      host.removeEventListener("pagehide", onPageHide);
      root.remove();
      if (host.arcadeCabinetPanel === api) delete host.arcadeCabinetPanel;
    },
  };
  const onPageHide = event => { if (!event.persisted) api.dispose(); };
  doc.addEventListener("visibilitychange", visibility);
  portrait.addEventListener("change", visibility);
  reduced.addEventListener("change", visibility);
  host.addEventListener("pagehide", onPageHide);
  host.arcadeCabinetPanel = api;
  wake();
  return api;
}

export function connectCabinetWorkshop(client, host = globalThis.window) {
  // The game iframe drives the parent's physical display; never duplicate it.
  let panel = host?.arcadeCabinetPanel;
  try { panel ??= host?.parent?.arcadeCabinetPanel; } catch { /* Cross-origin. */ }
  return panel?.connect(client) ?? (() => {});
}
