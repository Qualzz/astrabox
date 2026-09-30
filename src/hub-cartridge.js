// A camera crop, not a navigation or a second copy of the game. The rectangle
// interpolates from the whole tube to the thumbnail in unfiltered coordinates.
export function thumbnailCameraView(width, height, thumbnail, progress) {
  const t = Math.max(0, Math.min(1, progress));
  const eased = t * t * (3 - 2 * t);
  return {
    x: thumbnail.x * eased, y: thumbnail.y * eased,
    width: width + (thumbnail.width - width) * eased,
    height: height + (thumbnail.height - height) * eased,
  };
}

// Same-origin iframe for lifecycle/input isolation, NOT a security sandbox.
// Its real canvas is sampled only during the zoom; fullscreen is native Pixi.
export class HubCartridge {
  constructor({ viewport, input, reducedMotion, onState, onPreview, onZoom, onClear, onError }) {
    Object.assign(this, { viewport, input, reducedMotion, onState, onPreview, onZoom, onClear, onError });
    this.state = "idle";
    this.frame = null;
    this.api = null;
    this.onMessage = event => {
      if (!this.frame || event.source !== this.frame.contentWindow || event.origin !== location.origin) return;
      if (event.data?.type === "arcade:ready" && event.data.gameId === this.gameId && this.state === "loading") {
        clearTimeout(this.timeout);
        this.api = this.frame.contentWindow.arcadeEmbedded;
        if (!this.api) return this.fail(new Error("Le jeu n’a pas fourni son écran."));
        this.api.draw();
        this.onPreview(this.api.canvas);
        this.startedAt = performance.now();
        this.setState("zooming");
      } else if (event.data?.type === "arcade:error") this.fail(new Error(event.data.message));
      else if (event.data?.type === "arcade:exit" && this.state === "playing") this.exit();
    };
    this.onKeyDown = event => {
      if (event.code === "Escape" && ["loading", "zooming"].includes(this.state)) {
        event.preventDefault(); this.clear();
      }
    };
    window.addEventListener("message", this.onMessage);
    window.addEventListener("keydown", this.onKeyDown);
  }
  setState(state) {
    const previous = this.state;
    this.state = state;
    this.onState(state, previous);
  }
  acquireInput(target) {
    if (this.state !== "loading" || target !== this.frame?.contentWindow || !this.input) {
      throw new Error("La cartouche ne peut pas récupérer les contrôles de la borne.");
    }
    this.input.setEnabled(false);
    this.input.setTarget(target);
    return this.input;
  }
  launch(game, players) {
    if (this.state !== "idle") return;
    this.gameId = game.id;
    this.frame = document.createElement("iframe");
    this.frame.className = "hub-cartridge";
    this.frame.title = game.title;
    this.frame.allow = "microphone; autoplay";
    this.frame.style.visibility = "hidden";
    this.frame.src = `/index.html?${new URLSearchParams({ game: game.id, players, from: "hub", embedded: "1" })}`;
    this.setState("loading");
    this.timeout = setTimeout(() => this.fail(new Error("Le chargement du jeu a expiré.")), 30_000);
    this.viewport.append(this.frame);
  }
  tick(now) {
    if (!["zooming", "leaving"].includes(this.state)) return;
    const progress = this.reducedMotion ? 1 : Math.min(1, (now - this.startedAt) / 850);
    this.onZoom(this.state === "leaving" ? 1 - progress : progress);
    if (progress < 1) return;
    if (this.state === "leaving") { this.clear(); return; }
    this.frame.style.visibility = "visible";
    this.frame.contentWindow.focus();
    this.api.activate();
    this.setState("playing");
  }
  exit() {
    if (this.state !== "playing") return;
    this.api.suspend();
    this.onPreview(this.api.canvas);
    this.onZoom(1);
    this.frame.style.visibility = "hidden";
    this.startedAt = performance.now();
    this.setState("leaving");
    window.focus();
  }
  fail(error) {
    this.clear();
    this.onError(error);
  }
  clear() {
    clearTimeout(this.timeout);
    // Also covers an error/cancellation before the ready notification arrived.
    const api = this.api ?? this.frame?.contentWindow?.arcadeEmbedded;
    try { api?.dispose(); }
    finally {
      this.input?.setTarget(window);
      this.input?.setMenuBlocked(false);
      this.input?.setBlocked(false);
      this.frame?.remove(); this.frame = null; this.api = null;
      this.onClear(); this.setState("idle");
    }
  }
  dispose() {
    this.clear();
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("keydown", this.onKeyDown);
  }
}
