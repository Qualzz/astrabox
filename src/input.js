import { assignGamepads, loadGamepadProfiles, readMappedGamepad } from "./gamepad-mapping.js";
const STORAGE_KEY = "arcade:input-mapping:v1";
export const START_EXIT_HOLD_MS = 3000;
export const DEFAULT_INPUT_MAPPING = Object.freeze({
  1: { left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", a: "KeyK", b: "KeyL", c: "KeyI", d: "KeyO", e: "KeyU", f: "KeyP", g: "KeyJ", h: "Semicolon", start: "Enter" },
  2: { left: "KeyA", right: "KeyD", up: "KeyW", down: "KeyS", a: "KeyF", b: "KeyG", c: "KeyR", d: "KeyT", e: "KeyE", f: "KeyQ", g: "KeyZ", h: "KeyX", start: "Space" },
  system: { codex: "KeyC", exit: "Escape" },
});

export function loadInputMapping(storage = globalThis.localStorage) {
  let stored;
  try { stored = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null"); } catch { /* Defaults remain usable without storage. */ }
  const reserved = new Set(Object.entries(DEFAULT_INPUT_MAPPING).flatMap(([group, defaults]) =>
    Object.keys(defaults).map((action) => stored?.[group]?.[action]).filter((code) => typeof code === "string" && code)));
  return Object.fromEntries(Object.entries(DEFAULT_INPUT_MAPPING).map(([group, defaults]) => [group,
    Object.fromEntries(Object.entries(defaults).map(([action, code]) => [action,
      typeof stored?.[group]?.[action] === "string" ? stored[group][action] : reserved.has(code) ? "" : code])),
  ]));
}

export function saveInputMapping(mapping, storage = globalThis.localStorage) {
  const merged = loadInputMapping({ getItem: () => JSON.stringify(mapping) });
  const codes = Object.values(merged).flatMap(Object.values).filter(Boolean);
  if (new Set(codes).size !== codes.length) throw new Error("Chaque bouton doit avoir une touche différente.");
  storage?.setItem(STORAGE_KEY, JSON.stringify(merged));
  globalThis.window?.dispatchEvent(new Event("arcade-input-mapping-changed"));
  return merged;
}

export function getCodexKey() { return loadInputMapping().system.codex; }
export function isCodexKey(event) { return event.code === getCodexKey(); }
export function setCodexKey(code) {
  const mapping = loadInputMapping();
  mapping.system.codex = code;
  return saveInputMapping(mapping);
}

export function keyLabel(code) {
  if (!code) return "—";
  return ({ ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "SPACE", Escape: "ESC", Enter: "ENTER" })[code]
    ?? code.replace(/^Key|^Digit/, "");
}

const isEditable = (target) => Boolean(target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName));

export class ArcadeInput {
  constructor({ target = globalThis.window, navigator = globalThis.navigator, mapping = loadInputMapping(), gamepadProfiles = loadGamepadProfiles() } = {}) {
    this.target = null;
    this.navigator = navigator;
    this.mapping = mapping;
    this.gamepadProfiles = gamepadProfiles;
    this.padSystemPressed = new Set();
    this.padSystemDown = new Set();
    this.enabled = true;
    this.keysDown = new Set();
    this.keysPressed = new Set();
    this.gamepads = [null, null];
    this.previousGamepads = [null, null];
    this.startHoldSince = [null, null];
    this.startHoldFired = false;
    this.startExitHoldProgress = null;
    this.blocked = false;
    this.menuBlocked = false;
    this.onKeyDown = (event) => {
      if (!this.enabled || !event.code || event.defaultPrevented || isEditable(event.target)) return;
      const systemAction = Object.keys(this.mapping.system).find((action) => this.mapping.system[action] === event.code);
      const mapped = Object.values(this.mapping).some((map) => Object.values(map).includes(event.code));
      if (mapped) event.preventDefault();
      if (systemAction && !event.repeat) {
        const signal = new CustomEvent("arcade-system", { cancelable: true, detail: { action: systemAction, code: event.code } });
        if (this.target?.dispatchEvent(signal) === false) return;
      }
      if (this.blocked) return;
      if (!event.repeat) this.keysPressed.add(event.code);
      this.keysDown.add(event.code);
    };
    this.onKeyUp = (event) => {
      this.keysDown.delete(event.code);
      for (const player of [1, 2]) {
        if (event.code === this.mapping[player].start && !this.gamepads[player - 1]?.start) this.startHoldSince[player - 1] = null;
      }
      if ([1, 2].every(player => !this.down(player, "start"))) this.resetStartHold();
    };
    this.suspended = false;
    this.onBlur = () => { this.suspended = true; this.reset(); };
    this.onFocus = () => { this.suspended = false; this.reset(); };
    this.onMappingChange = () => { this.mapping = loadInputMapping(); this.gamepadProfiles = loadGamepadProfiles(); this.reset(); };
    this.setTarget(target);
  }

  // Transfer keyboard/focus ownership to a cartridge without creating another
  // player assignment. Gamepads are still read from the hub's navigator and
  // the exact same calibrated profiles, regardless of the iframe's indexing.
  setTarget(target) {
    for (const [type, listener] of this.targetListeners()) this.target?.removeEventListener(type, listener);
    this.target = target;
    for (const [type, listener] of this.targetListeners()) this.target?.addEventListener(type, listener);
    this.suspended = false;
    this.reset();
  }
  targetListeners() {
    return [["keydown", this.onKeyDown], ["keyup", this.onKeyUp], ["blur", this.onBlur],
      ["focus", this.onFocus], ["arcade-input-mapping-changed", this.onMappingChange]];
  }

  resetStartHold() { this.startHoldSince = [null, null]; this.startHoldFired = false; this.startExitHoldProgress = null; }
  reset() { this.keysDown.clear(); this.keysPressed.clear(); this.gamepads = [null, null]; this.previousGamepads = [null, null]; this.padSystemPressed.clear(); this.resetStartHold(); }
  setEnabled(value) { this.enabled = Boolean(value); this.reset(); }
  setBlocked(value) { if (this.blocked === Boolean(value)) return; this.blocked = Boolean(value); this.reset(); }
  setMenuBlocked(value) { this.menuBlocked = Boolean(value); this.keysPressed.clear(); this.resetStartHold(); }
  get controlLabels() {
    const pads = assignGamepads(this.navigator?.getGamepads?.() ?? [], this.gamepadProfiles);
    const padLabel = (action) => pads.some((pad, i) => pad && (this.gamepadProfiles[i]
      ? this.gamepadProfiles[i].actions[action]?.length : pad.mapping === "standard"));
    return { p1Start: pads[0] ? "START 1P" : keyLabel(this.mapping[1].start),
      p2Start: pads[1] ? "START 2P" : keyLabel(this.mapping[2].start),
      confirm: "A", back: "B",
      exit: "START 3 SEC",
      codex: padLabel("codex") ? "CODEX" : keyLabel(this.mapping.system.codex) };
  }
  beginFrame() {
    this.padSystemPressed.clear();
    const pads = this.suspended || !this.enabled ? [] : this.navigator?.getGamepads?.() ?? [];
    this.gamepads = assignGamepads(pads, this.gamepadProfiles).map((pad, i) => readMappedGamepad(pad, this.gamepadProfiles[i]));
    // Closing a menu can reset gameplay inside dispatchEvent. Track physical
    // system edges independently so a held CODEX cannot reopen that menu.
    const previousSystem = this.padSystemDown;
    this.padSystemDown = new Set(this.gamepads.flatMap((pad, i) => ["codex", "exit"].filter(action => pad?.[action]).map(action => `${i}:${action}`)));
    for (const action of ["codex", "exit"]) {
      if (![...this.padSystemDown].some(key => key.endsWith(`:${action}`) && !previousSystem.has(key))) continue;
      const signal = new CustomEvent("arcade-system", { cancelable: true, detail: { action, source: "gamepad" } });
      if (this.target?.dispatchEvent(signal) !== false) this.padSystemPressed.add(action);
    }
  }
  endFrame() {
    this.keysPressed.clear();
    this.padSystemPressed.clear();
    this.previousGamepads = this.gamepads.map((pad) => pad && { ...pad });
  }
  readGamepad(gamepad) {
    return readMappedGamepad(gamepad, null);
  }
  down(player, action) {
    if (!this.enabled || this.blocked || (this.menuBlocked && action === "start")) return false;
    return Boolean(this.keysDown.has(this.mapping[player]?.[action]) || this.gamepads[player - 1]?.[action]);
  }
  pressed(player, action) {
    if (!this.enabled || this.blocked || (this.menuBlocked && action === "start")) return false;
    return Boolean(this.keysPressed.has(this.mapping[player]?.[action])
      || (this.gamepads[player - 1]?.[action] && !this.previousGamepads[player - 1]?.[action]));
  }
  systemPressed(action) {
    return this.enabled && !this.blocked && !this.menuBlocked && (this.keysPressed.has(this.mapping.system[action]) || this.padSystemPressed.has(action));
  }
  // Menu aliases only: gameplay still sees untouched A/B actions. Either
  // control panel can confirm a solo game; START P2 retains its 2P meaning.
  menuConfirmPlayer(maxPlayers = 1, currentPlayers = 1) {
    if (this.menuBlocked || this.blocked) return 0;
    if (this.pressed(1, "a") || this.pressed(1, "start")) return Math.min(maxPlayers, currentPlayers);
    if (this.pressed(2, "a")) return Math.min(maxPlayers, 2);
    if (this.pressed(2, "start") && maxPlayers > 1) return 2;
    return 0;
  }
  menuBackPressed() {
    return !this.menuBlocked && !this.blocked && (this.pressed(1, "b") || this.pressed(2, "b"));
  }
  // Called only by the cartridge runtime, never the hub's voice START handler.
  // Use wall time, not the game's clamped dt: 3 seconds even at a low frame rate.
  startHeldForExit(now = performance.now()) {
    if (!this.enabled || this.blocked || this.menuBlocked || this.suspended) { this.resetStartHold(); return false; }
    for (const player of [1, 2]) {
      const i = player - 1;
      this.startHoldSince[i] = this.down(player, "start") ? this.startHoldSince[i] ?? now : null;
    }
    const active = this.startHoldSince.filter(since => since !== null);
    if (!active.length) { this.resetStartHold(); return false; }
    this.startExitHoldProgress = Math.max(0, Math.min(1, (now - Math.min(...active)) / START_EXIT_HOLD_MS));
    if (this.startHoldFired || this.startExitHoldProgress < 1) return false;
    this.startHoldFired = true;
    return true;
  }
  destroy() {
    for (const [type, listener] of this.targetListeners()) this.target?.removeEventListener(type, listener);
    this.target = null;
    this.reset();
  }
}
