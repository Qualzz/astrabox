import { loadInputMapping, saveInputMapping, keyLabel } from "./input.js";
import { PLAYER_ACTIONS, BUTTON_LABELS, REQUIRED_PLAYER_ACTIONS, CALIBRATION_ACTIONS, activeGamepadBindings, bindingKey, loadGamepadProfiles, readMappedGamepad, assignGamepads, saveGamepadProfile } from "./gamepad-mapping.js";

if (new URLSearchParams(location.search).get("debug") !== "1") location.replace("/moon.html");
const $ = (id) => document.getElementById(id);
const labels = { left: "JOYSTICK GAUCHE", right: "JOYSTICK DROITE", up: "JOYSTICK HAUT", down: "JOYSTICK BAS", ...BUTTON_LABELS, start: "START", codex: "CODEX", exit: "SORTIE" };
const actions = CALIBRATION_ACTIONS;
let mode = null, index = -1, device = null, draft = null, ready = false;
let lastLive = "", keyboardDown = new Set();
const player = () => Number($("player").value);
const pads = () => Array.from(navigator.getGamepads?.() ?? []).filter(Boolean);
function status(text) { $("status").textContent = text; }
function finish(message) {
  mode = null; device = null; $("wizard").hidden = true; $("setup").hidden = false; $("player").disabled = false;
  status(message);
}
function paintStep() {
  const action = actions[index];
  $("prompt").textContent = index < 0 ? "APPUYEZ SUR UN BOUTON DE LA MANETTE" : `${player()}P · ${labels[action]}`;
  $("hint").textContent = index < 0 ? "Laissez le joystick au repos. La première manette qui répond sera attribuée à ce joueur."
    : `Étape ${index + 1} / ${actions.length}. ${mode === "pad" ? "Relâchez tout, puis actionnez uniquement cette entrée." : "Appuyez sur la touche envoyée par ce bouton."}`;
  if (action === "start") $("hint").textContent += " Utilisez le bouton physique marqué COIN : il sert de START, y compris pour rejoindre en P2.";
  if (action === "codex") $("hint").textContent += " Utilisez votre deuxième bouton supplémentaire pour appeler Codex.";
  $("skip").hidden = index < 0 || REQUIRED_PLAYER_ACTIONS.includes(action);
  $("skip").textContent = action === "codex" ? "Garder CODEX au clavier" : "Je n’ai pas ce bouton — passer";
  $("prompt").focus({ preventScroll: true });
}
function begin(nextMode) {
  mode = nextMode; index = mode === "pad" ? -1 : 0; ready = false; device = null;
  draft = mode === "pad" ? { actions: Object.fromEntries([...PLAYER_ACTIONS, "codex", "exit"].map(action => [action, []])), deadzone: .45 } : loadInputMapping();
  $("wizard").hidden = false; $("setup").hidden = true; $("player").disabled = true;
  status(""); paintStep();
}
function advance() {
  ready = false; index += 1;
  if (index < actions.length) return paintStep();
  try {
    if (mode === "pad") saveGamepadProfile(player(), draft);
    else saveInputMapping(draft);
    finish(`MAPPING ${player()}P ENREGISTRÉ. Testez les entrées ci-dessous avant de revenir au menu.`);
  } catch (error) { finish(`Non enregistré : ${error.message} Recommencez le mapping.`); }
}
$("pad").onclick = () => begin("pad");
$("keyboard").onclick = () => begin("keyboard");
$("cancel").onclick = () => finish("Annulé. Mapping précédent conservé.");
$("skip").onclick = () => {
  const action = actions[index];
  if (!mode || !action || REQUIRED_PLAYER_ACTIONS.includes(action)) return;
  if (mode === "pad") draft.actions[action] = [];
  else if (action !== "codex") draft[player()][action] = "";
  advance();
};
$("reset").onclick = () => { saveGamepadProfile(player(), null); status(`Mapping automatique rétabli pour ${player()}P.`); };
window.addEventListener("keydown", (event) => {
  if (/^(BUTTON|SELECT|A)$/.test(event.target.tagName) && (!mode || ["Enter", "Space"].includes(event.code))) return;
  keyboardDown.add(event.code);
  if (mode !== "keyboard") return;
  event.preventDefault(); if (event.repeat) return;
  const action = actions[index];
  const group = PLAYER_ACTIONS.includes(action) ? player() : "system";
  // Reserve the other player's keys and already captured keys. Future slots
  // in this player's old mapping may be reassigned freely during calibration.
  const reserved = [...Object.values(draft[3 - player()]), ...actions.slice(0, index).map(a => draft[PLAYER_ACTIONS.includes(a) ? player() : "system"][a]),
    ...Object.entries(draft.system).filter(([a]) => group !== "system" || a !== action).map(([, code]) => code)];
  if (reserved.includes(event.code)) return status("Cette touche est déjà attribuée. Choisissez une autre entrée.");
  draft[group][action] = event.code; status(`${labels[action]} : ${keyLabel(event.code)}`); advance();
}, true);
window.addEventListener("keyup", (event) => keyboardDown.delete(event.code));
window.addEventListener("blur", () => keyboardDown.clear());

function tick() {
  const connected = pads();
  if (mode === "pad") {
    if (index < 0) {
      const pad = connected.find((p) => p.buttons.some((b) => b.pressed));
      if (pad) {
        const other = loadGamepadProfiles()[2 - player()];
        if (other?.index === pad.index && other.id === pad.id) status("Cette manette est déjà attribuée à l’autre joueur.");
        else { device = { id: pad.id, index: pad.index }; Object.assign(draft, device); index = 0; paintStep(); }
      }
    } else {
      const pad = connected.find((p) => p.id === device.id && p.index === device.index);
      if (!pad) status("Manette débranchée. Rebranchez-la au même port ou annulez.");
      else {
        const active = activeGamepadBindings(pad);
        if (!active.length) ready = true;
        else if (ready) {
          ready = false;
          const binding = active[0];
          if (Object.values(draft.actions).flat().some((b) => bindingKey(b) === bindingKey(binding))) status("Cette entrée est déjà attribuée. Relâchez et essayez une autre.");
          else { draft.actions[actions[index]] = [binding]; status(`${labels[actions[index]]} : ${bindingKey(binding)}`); advance(); }
        }
      }
    }
  }
  const profiles = loadGamepadProfiles();
  const assigned = assignGamepads(navigator.getGamepads?.() ?? [], profiles);
  const mapping = loadInputMapping();
  const live = [1, 2].map((p) => {
    const state = readMappedGamepad(assigned[p - 1], profiles[p - 1]);
    const down = [...new Set([...Object.entries(state ?? {}).filter(([, v]) => v).map(([a]) => a),
      ...Object.entries(mapping[p]).filter(([, code]) => keyboardDown.has(code)).map(([a]) => a)])];
    return `${p}P : ${down.map((a) => labels[a]).join(" · ") || "—"}\n${assigned[p - 1]?.id ?? "Pas de manette détectée (appuyez sur un bouton pour l’activer)"}`;
  }).join("\n\n");
  if (live !== lastLive) { $("live").textContent = live; lastLive = live; }
  requestAnimationFrame(tick);
}
tick();
