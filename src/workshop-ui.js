import { WorkshopClient } from "./workshop-client.js";
import { getCodexKey, setCodexKey } from "./input.js";
import { connectCabinetWorkshop } from "./cabinet-panel.js";

const LABELS = {
  idle: "PRESS START", connecting: "CONNEXION", reconnecting: "CONNEXION",
  listening: "PARLEZ", heard: "BIEN REÇU", processing: "UN INSTANT", speaking: "CODEX PARLE", thinking: "UN INSTANT",
  building: "CRÉATION", testing: "VÉRIFICATION", applying: "MISE À JOUR",
  ready: "PRÊT", error: "VOCAL INDISPONIBLE", disconnected: "VOCAL INDISPONIBLE",
};
const WORKING = new Set(["building", "testing", "applying"]);
const DIAGNOSTIC_LABELS = {
  "no-input": "MICRO SILENCIEUX", "microphone-muted": "MICRO MUET",
  "audio-suspended": "START · ACTIVER LE SON", "playback-blocked": "START · ACTIVER LE SON",
  "awaiting-service": "RÉPONSE EN ATTENTE",
};

/** Cabinet mode has no panel: the robot's TV or cartridge renderer owns the
 * image. Text entry and connection diagnostics exist only in ?debug=1. */
export function mountWorkshop({
  mode = "game", getGameContext = async () => ({}), onGameUpdated,
  onOpenChange = () => {}, onTextFocusChange = () => {},
  onStatus = () => {}, onMessage = () => {}, onVoiceActivity = () => {}, statusInCanvas = false,
} = {}) {
  if (!document.querySelector("link[data-workshop-style]")) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("../workshop.css", import.meta.url).href;
    stylesheet.dataset.workshopStyle = "true";
    document.head.append(stylesheet);
  }

  const debug = new URLSearchParams(location.search).get("debug") === "1";
  const root = document.createElement("aside");
  root.className = `workshop workshop--${mode}`;
  root.dataset.statusInCanvas = String(statusInCanvas);
  const announcement = document.createElement("span");
  announcement.className = "workshop-visually-hidden";
  announcement.setAttribute("role", "status");
  // The mapped CODEX system action toggles the workshop, on the hub and in
  // cartridges alike. There is no duplicate clickable launcher on the screen.
  root.append(announcement);
  (document.querySelector(".crt-content") ?? document.body).append(root);

  let opened = false;
  let disposed = false;
  let voicePending = false;
  let voiceRequest = 0;
  let currentState = "idle";
  let currentMessage = "";
  let voiceDiagnostic = null;
  let mapping = false;
  let operator = null;
  const client = new WorkshopClient({ getGameContext, onGameUpdated });
  const disconnectCabinet = connectCabinetWorkshop(client);

  function paint() {
    const statusLabel = DIAGNOSTIC_LABELS[voiceDiagnostic?.code] || LABELS[currentState] || "CODEX";
    const label = mode === "hub" ? statusLabel.replace("PRESS START", "APPUYEZ SUR A").replace("START ·", "A ·") : statusLabel;
    const voiceActive = Boolean(client.voiceActive);
    root.dataset.state = currentState;
    root.dataset.microphone = voicePending ? "connecting" : voiceActive ? "on" : "off";
    announcement.textContent = opened ? voiceDiagnostic?.message || label : "";
    if (operator) {
      operator.hidden = !opened;
      operator.querySelector("output").textContent = `${currentState} — ${currentMessage}`;
      operator.querySelector(".workshop-map").textContent = mapping ? "Appuyer sur une touche (Échap : annuler)" : `Mapper CODEX (${getCodexKey()})`;
    }
    onStatus({ state: currentState, message: currentMessage, label, open: opened, voiceActive, voiceDiagnostic });
  }

  function setStatus(detail = {}) {
    // The stop acknowledgement can arrive after a connection error. Keep the
    // actionable failure visible until retry, close, or actual new activity.
    if (opened && currentState === "error" && detail.state === "idle") return;
    currentState = detail.state || "idle";
    currentMessage = detail.message || "";
    paint();
  }

  function reportError(error) {
    setStatus({ state: "error", message: error?.message || "Connexion à Codex impossible." });
  }

  function receiveMessage(detail) {
    const text = String(detail?.text || "").trim();
    if (!text) return;
    if (operator) operator.querySelector(".workshop-debug-message").textContent = text;
    onMessage({ ...detail, text });
  }

  client.addEventListener("status", (event) => setStatus(event.detail));
  client.addEventListener("message", (event) => receiveMessage(event.detail));
  client.addEventListener("transcript", (event) => receiveMessage(event.detail));
  client.addEventListener("voice-activity", (event) => onVoiceActivity(event.detail));
  client.addEventListener("voice-diagnostic", (event) => {
    voiceDiagnostic = event.detail?.code ? event.detail : null;
    if (voiceDiagnostic) announcement.textContent = voiceDiagnostic.message;
    paint();
  });
  client.addEventListener("voice-state", (event) => {
    const state = event.detail?.state;
    if (["listening", "speaking", "processing", "heard"].includes(state) && !WORKING.has(currentState)) setStatus({ state });
    else paint();
  });
  client.addEventListener("voice-closed", () => {
    voiceDiagnostic = null;
    if (!WORKING.has(currentState) && currentState !== "error") setStatus({ state: "idle" });
    else paint();
  });
  client.addEventListener("workshop-status", (event) => {
    if (mode === "hub" && !opened) setStatus(event.detail);
  });
  client.addEventListener("game-updated", (event) => {
    root.dispatchEvent(new CustomEvent("workshop-game-updated", { detail: event.detail, bubbles: true }));
  });

  function open({ voice = false } = {}) {
    if (disposed) return;
    opened = true;
    root.classList.add("is-open");
    document.body.dataset.workshopOpen = mode;
    onOpenChange(true);
    paint();
    if (voice) void startVoice();
  }

  async function startVoice() {
    if (disposed || voicePending) return;
    if (!opened) open();
    voicePending = true;
    const request = ++voiceRequest;
    paint();
    try { await client.startVoice(); }
    catch (error) { if (opened && request === voiceRequest) reportError(error); }
    finally { if (request === voiceRequest) { voicePending = false; paint(); } }
  }

  async function stopVoice() {
    const request = voiceRequest;
    try { await client.stopVoice(); }
    catch (error) { if (opened && request === voiceRequest) reportError(error); }
    finally { paint(); }
  }

  async function toggleVoice() {
    if (client.voiceActive) await stopVoice();
    else await startVoice();
  }

  function close() {
    opened = false;
    voiceRequest++;
    voicePending = false;
    mapping = false;
    operator?.querySelector("textarea")?.blur();
    root.classList.remove("is-open");
    delete document.body.dataset.workshopOpen;
    onTextFocusChange(false);
    onOpenChange(false);
    paint();
    void stopVoice();
  }

  function toggle() {
    if (opened) close();
    else open({ voice: mode === "game" });
  }

  // No hidden chat application in cabinet mode. These controls are only built
  // when an operator explicitly opens the development URL with ?debug=1.
  if (debug) {
    operator = document.createElement("section");
    operator.className = "workshop-debug";
    operator.setAttribute("aria-label", "Outils opérateur");
    operator.innerHTML = `<output></output><p class="workshop-debug-message"></p>
      <form><label for="workshop-request">Texte opérateur — alternative au vocal</label>
      <textarea id="workshop-request" rows="2" maxlength="6000"></textarea>
      <button type="submit">Envoyer</button></form>
      <button type="button" class="workshop-debug-voice">Vocal</button>
      <button type="button" class="workshop-debug-stop">Interrompre</button>
      <button type="button" class="workshop-map"></button>
      <a href="/controls.html?debug=1">Mapper les contrôles 1P / 2P</a>`;
    root.append(operator);
    const input = operator.querySelector("textarea");
    input.addEventListener("focus", () => onTextFocusChange(true));
    input.addEventListener("blur", () => onTextFocusChange(false));
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); operator.querySelector("form").requestSubmit(); }
    });
    operator.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      try { await client.sendText(input.value.trim()); input.value = ""; input.blur(); }
      catch (error) { reportError(error); }
    });
    operator.querySelector(".workshop-debug-voice").addEventListener("click", () => void toggleVoice());
    operator.querySelector(".workshop-debug-stop").addEventListener("click", () => Promise.resolve(client.interrupt()).catch(reportError));
    operator.querySelector(".workshop-map").addEventListener("click", () => { mapping = !mapping; paint(); });
  }

  function handleKey(event) {
    if (!opened) return;
    if (mapping) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.code !== "Escape") {
        try { setCodexKey(event.code); } catch (error) { reportError(error); }
      }
      mapping = false;
      paint();
    } else if (event.code === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  }

  function handleSystem(event) {
    if (event.detail?.action === "codex") { event.preventDefault(); toggle(); }
    else if (opened && event.detail?.action === "exit") { event.preventDefault(); close(); }
  }

  window.addEventListener("keydown", handleKey, true);
  window.addEventListener("arcade-system", handleSystem);
  window.addEventListener("arcade-input-mapping-changed", paint);
  paint();
  const api = {
    open, close, toggle, startVoice, stopVoice, toggleVoice,
    get isOpen() { return opened; }, get client() { return client; },
    get state() { return currentState; }, root,
    dispose() {
      disposed = true;
      close();
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("arcade-system", handleSystem);
      window.removeEventListener("arcade-input-mapping-changed", paint);
      client.dispose();
      disconnectCabinet();
      root.remove();
      if (window.arcadeWorkshop === api) delete window.arcadeWorkshop;
    },
  };
  window.arcadeWorkshop = api;
  return api;
}
