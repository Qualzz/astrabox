export const GAMEPAD_STORAGE_KEY = "arcade:gamepads:v1";
export const PLAYER_ACTIONS = Object.freeze(["left", "right", "up", "down", "start", "a", "b", "c", "d", "e", "f", "g", "h"]);
export const BUTTON_LABELS = Object.freeze({ a: "A", b: "B", c: "X", d: "Y", e: "L1", f: "R1", g: "L2", h: "R2" });
export const REQUIRED_PLAYER_ACTIONS = Object.freeze(["left", "right", "up", "down", "start"]);
export const CALIBRATION_ACTIONS = Object.freeze(["left", "right", "up", "down", ...Object.keys(BUTTON_LABELS), "start", "codex"]);
const allActions = [...PLAYER_ACTIONS, "codex", "exit"];
const button = (index) => ({ type: "button", index });
const axis = (index, sign) => ({ type: "axis", index, sign });
export const STANDARD_GAMEPAD_MAPPING = Object.freeze({
  left: [button(14), axis(0, -1)], right: [button(15), axis(0, 1)],
  up: [button(12), axis(1, -1)], down: [button(13), axis(1, 1)],
  start: [button(9)],
  a: [button(0)], b: [button(1)], c: [button(2)], d: [button(3)],
  e: [button(4)], f: [button(5)], g: [button(6)], h: [button(7)],
  codex: [button(16)], exit: [button(11)],
});

export function bindingKey(binding) {
  return binding.type === "button" ? `b${binding.index}` : `a${binding.index}:${binding.sign}`;
}

export function validateGamepadProfile(profile) {
  if (!profile || typeof profile.id !== "string" || !Number.isInteger(profile.index) || profile.index < 0)
    throw new Error("Manette invalide.");
  if (!(profile.deadzone >= .1 && profile.deadzone <= .8)) throw new Error("Zone morte invalide.");
  const used = new Set();
  for (const action of allActions) {
    const bindings = profile.actions?.[action];
    if (!Array.isArray(bindings) || (REQUIRED_PLAYER_ACTIONS.includes(action) && bindings.length === 0))
      throw new Error(`Mapping manquant : ${action}`);
    for (const binding of bindings) {
      if (!["axis", "button"].includes(binding?.type) || !Number.isInteger(binding.index) || binding.index < 0 || binding.index > 63
        || (binding.type === "axis" && ![-1, 1].includes(binding.sign))) throw new Error("Entrée invalide.");
      const key = bindingKey(binding);
      if (used.has(key)) throw new Error("Cette entrée est déjà attribuée.");
      used.add(key);
    }
  }
  // Old profiles may still contain a COIN binding. Ignore that retired action
  // without changing START/CODEX or the identity/assignment of either player.
  return { ...profile, actions: Object.fromEntries(allActions.map(action => [action, profile.actions[action]])) };
}

export function loadGamepadProfiles(storage = globalThis.localStorage) {
  let stored;
  try { stored = JSON.parse(storage?.getItem(GAMEPAD_STORAGE_KEY) ?? "null"); } catch { /* Usable defaults. */ }
  return [1, 2].map((player) => {
    try { return validateGamepadProfile(stored?.[player - 1]); } catch { return null; }
  });
}

export function saveGamepadProfile(player, profile, storage = globalThis.localStorage) {
  if (![1, 2].includes(player)) throw new Error("Joueur invalide.");
  if (profile) profile = validateGamepadProfile(profile);
  const profiles = loadGamepadProfiles(storage);
  const other = profiles[2 - player];
  if (profile && other && profile.index === other.index && profile.id === other.id)
    throw new Error("Cette manette est déjà attribuée à l’autre joueur.");
  profiles[player - 1] = profile;
  storage?.setItem(GAMEPAD_STORAGE_KEY, JSON.stringify(profiles));
  globalThis.window?.dispatchEvent(new Event("arcade-input-mapping-changed"));
  return profiles;
}

// Preserve physical slots, including holes. Two identical USB encoders must
// never collapse onto P1 when P1 is unplugged. Unique device IDs may reconnect
// at a different browser index; identical devices require the operator to map
// again if the OS actually reorders them.
export function assignGamepads(pads, profiles) {
  const available = Array.from(pads).filter((pad) => pad && pad.connected !== false);
  const used = new Set();
  const assigned = profiles.map((profile) => {
    if (!profile) return null;
    const pad = available.find((p) => p.index === profile.index && p.id === profile.id);
    if (pad && !used.has(pad.index)) { used.add(pad.index); return pad; }
    return null;
  });
  return profiles.map((profile, player) => {
    if (assigned[player]) return assigned[player];
    let pad;
    if (profile) {
      const matches = available.filter((p) => p.id === profile.id && !used.has(p.index));
      if (profiles.filter((p) => p?.id === profile.id).length === 1 && matches.length === 1) pad = matches[0];
    } else pad = available.find((p) => p.index === player && !used.has(p.index));
    if (pad) used.add(pad.index);
    return pad ?? null;
  });
}

export function readMappedGamepad(pad, profile) {
  if (!pad || pad.connected === false) return null;
  const actions = profile?.actions ?? (pad.mapping === "standard" ? STANDARD_GAMEPAD_MAPPING : {});
  const deadzone = profile?.deadzone ?? .45;
  return Object.fromEntries(Object.entries(actions).filter(([action]) => allActions.includes(action)).map(([action, bindings]) => [action, bindings.some((binding) =>
    binding.type === "button"
      ? Boolean(pad.buttons[binding.index]?.pressed || pad.buttons[binding.index]?.value > .55)
      : (pad.axes[binding.index] ?? 0) * binding.sign > deadzone)]));
}

// Used by the calibration wizard. Require neutral between every capture; axis
// noise below the dead zone and analog triggers at rest do not advance steps.
export function activeGamepadBindings(pad, deadzone = .55) {
  if (!pad) return [];
  return [
    ...pad.buttons.flatMap((b, index) => b.pressed || b.value > .55 ? [button(index)] : []),
    ...pad.axes.flatMap((value, index) => Math.abs(value) > deadzone ? [axis(index, Math.sign(value))] : []),
  ];
}
