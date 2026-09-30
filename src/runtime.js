import { Assets, Container, Rectangle } from "pixi.js";
import { ArcadeInput } from "./input.js";
import { ArcadeAudio } from "./audio.js";
import { createCrtFilter, updateCrtFilter } from "./crt-filter.js";
import { loadPublishedCartridge } from "./cartridge-loader.js";
import { TvCaption } from "./tv-caption.js";
import { getHudSafeArea } from "./hud-safe-area.js";
import { StartExitIndicator } from "./start-exit-indicator.js";

// Snapshot at activation time, never when a Codex job begins.
export function transferLiveState(previous, next, api) {
  let snapshot = structuredClone(previous.captureState());
  if ((previous.stateVersion ?? 1) !== (next.stateVersion ?? 1)) {
    if (!next.migrateState) throw new Error("La structure de la partie a changé.");
    snapshot = next.migrateState(snapshot, previous.stateVersion ?? 1, api);
    if (snapshot?.then) throw new Error("La migration doit être synchrone.");
  }
  const restored = next.restoreState(snapshot, api);
  if (restored === false || restored?.then) throw new Error("Cette modification nécessite un redémarrage.");
}

export class ArcadeRuntime {
  constructor(app, statusNode, games, { onExit = null, input = null, ownsInput = true, loadGame = loadPublishedCartridge, paused = false } = {}) {
    this.app = app;
    this.statusNode = statusNode;
    this.games = games;
    this.onExit = onExit;
    this.loadGame = loadGame;
    this.input = input ?? new ArcadeInput();
    this.ownsInput = ownsInput;
    this.audio = new ArcadeAudio({ musicActive: !paused });
    this.selectedIndex = 0;
    this.state = "attract";
    this.stateTime = 0;
    this.playerCount = 0;
    this.result = null;
    this.noticeTime = 0;
    this.paused = paused;
    this.reloadSequence = 0;
    this.pendingReload = null;
    this.restartCandidate = null;

    this.screenLayer = new Container();
    this.gameLayer = new Container();
    this.uiLayer = new Container();
    this.systemLayer = new Container();
    this.screenLayer.addChild(this.gameLayer, this.uiLayer, this.systemLayer);
    this.screenLayer.filterArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
    this.crtFilter = createCrtFilter();
    this.screenLayer.filters = [this.crtFilter];
    app.stage.addChild(this.screenLayer);

    const runtime = this;
    this.api = {
      width: app.screen.width,
      height: app.screen.height,
      hudSafeArea: getHudSafeArea(app.screen.width, app.screen.height),
      input: this.input,
      assets: Assets,
      audio: this.audio,
      endGame: (result) => this.endGame(result),
      acceptPlayer: (player, notice) => this.acceptPlayer(player, notice),
      get playerCount() { return runtime.playerCount; },
    };
    this.exitHoldIndicator = new StartExitIndicator(this.api.width, this.api.hudSafeArea);
    this.systemLayer.addChild(this.exitHoldIndicator);
    games.forEach((game) => game.configure?.(game.config ?? {}, this.api));
    this.showAttract();
    this.tick = (ticker) => this.frame(Math.min(ticker.deltaMS / 1000, 0.05));
    app.ticker.add(this.tick);
  }

  get selectedGame() { return this.games[this.selectedIndex]; }
  setPaused(value) { this.paused = Boolean(value); this.audio.setMusicActive(!this.paused); }

  setWorkshopStatus({ open, state, label, voiceActive } = {}) {
    this.audio.setMusicDucked(Boolean(voiceActive));
    if (!this.workshopText) {
      this.workshopText = new TvCaption({ maxWidth: this.api.hudSafeArea.width - 16 });
      this.workshopText.position.set(this.api.width / 2, this.api.hudSafeArea.bottom - 5);
      this.systemLayer.addChild(this.workshopText);
    }
    this.workshopText.text = open ? `CODEX · ${label || (voiceActive ? "ÉCOUTE" : state === "error" ? "INDISPONIBLE" : "PRÊT")}` : "";
    this.workshopText.visible = Boolean(open);
  }

  frame(dt) {
    this.input.beginFrame();
    // All replacements happen synchronously here, between simulation updates.
    if (this.pendingReload) {
      const pending = this.pendingReload;
      this.pendingReload = null;
      pending.resolve(this.activateReplacement(pending.game, pending.event));
    }
    this.stateTime += dt;
    this.noticeTime = Math.max(0, this.noticeTime - dt);
    if (this.noticeTime === 0 && this.noticeContainer) this.noticeContainer.visible = false;
    updateCrtFilter(this.crtFilter, dt);
    const shouldExit = this.input.startHeldForExit();
    this.exitHoldIndicator?.update(this.paused || this.input.startHoldFired ? null : this.input.startExitHoldProgress);
    if (shouldExit) this.returnToAttract();
    else if (this.restartCandidate && this.input.pressed(1, "start")) this.restartWithCandidate();
    else if (this.restartCandidate && this.input.systemPressed("exit")) this.dismissRestart();
    else if (this.input.systemPressed("exit")) this.returnToAttract();
    else if (!this.paused) {
      if (this.state === "attract") this.updateAttract(dt);
      // Don't feed the same confirmation edge into gameplay after a menu
      // changes phase (A may also shoot or place a block in the cartridge).
      else if (this.state === "playing") this.updatePlaying(dt);
      else if (this.state === "gameover") this.updateGameOver(dt);
    }
    this.updateStatus();
    this.input.endFrame();
  }

  updateAttract(dt) {
    if (this.input.menuBackPressed()) { this.returnToAttract(); return; }
    let changed = false;
    if (this.input.pressed(1, "left") || this.input.pressed(2, "left")) {
      this.selectedIndex = (this.selectedIndex - 1 + this.games.length) % this.games.length;
      changed = true;
    }
    if (this.input.pressed(1, "right") || this.input.pressed(2, "right")) {
      this.selectedIndex = (this.selectedIndex + 1) % this.games.length;
      changed = true;
    }
    if (changed) this.showAttract();
    this.selectedGame.updateAttract?.(dt, this.api);
    const players = this.input.menuConfirmPlayer(this.selectedGame.maxPlayers);
    if (players) this.startGame(players);
  }

  updatePlaying(dt) {
    const game = this.selectedGame;
    if (this.input.pressed(2, "start") && this.playerCount === 1 && game.maxPlayers > 1) {
      const handled = game.onPlayerJoinRequested?.(2, this.api) ?? false;
      if (!handled) this.showNotice("PLAYER 2 UNAVAILABLE");
    }
    game.update(dt, this.api);
  }

  updateGameOver(dt) {
    if (this.input.menuBackPressed()) { this.returnToAttract(); return; }
    this.selectedGame.updateGameOver?.(dt, this.api);
    if (this.stateTime < 0.6) return;
    const players = this.input.menuConfirmPlayer(this.selectedGame.maxPlayers, this.playerCount || 1);
    if (players) this.startGame(players);
  }

  startGame(players) {
    this.clearLayers();
    this.state = "playing";
    this.stateTime = 0;
    this.playerCount = Math.min(Math.max(1, players), this.selectedGame.maxPlayers);
    this.result = null;
    this.selectedGame.configure?.(this.selectedGame.config ?? {}, this.api);
    this.gameLayer.addChild(this.selectedGame.mount(this.api));
    this.selectedGame.start(this.api);
  }

  acceptPlayer(player, notice = "PLAYER 2 JOINED") {
    if (this.state !== "playing" || player !== 2 || this.playerCount !== 1 || this.selectedGame.maxPlayers < 2) return false;
    this.playerCount = 2;
    this.showNotice(notice);
    return true;
  }

  endGame(result = {}) {
    if (this.state !== "playing") return;
    const score = Number.isFinite(result.score) ? Math.max(0, Math.floor(result.score)) : 0;
    this.result = { score, label: result.label ?? "SCORE", detail: result.detail ?? "", leaderboard: this.saveScore(score) };
    this.state = "gameover";
    this.stateTime = 0;
    this.showGameOver();
  }

  saveScore(score) {
    const key = `arcade:${this.selectedGame.id}:${this.playerCount}p`;
    let scores = [];
    try {
      const stored = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (Array.isArray(stored)) scores = stored.filter((entry) => typeof entry.name === "string" && Number.isFinite(entry.score));
    } catch { /* A broken score record must not prevent a game ending. */ }
    scores.push({ name: this.playerCount === 2 ? "TEAM" : "P1", score });
    scores.sort((a, b) => b.score - a.score);
    scores = scores.slice(0, 5);
    try { localStorage.setItem(key, JSON.stringify(scores)); } catch { this.showNotice("SCORE STORAGE UNAVAILABLE"); }
    return scores;
  }

  returnToAttract() {
    this.dismissRestart();
    // Keep the last image intact for the hub's return transition. The owner
    // disposes the cartridge afterwards, rather than flashing an empty canvas.
    if (this.onExit) { this.setPaused(true); this.audio.stopAll(); this.onExit(); return; }
    this.state = "attract";
    this.stateTime = 0;
    this.playerCount = 0;
    this.result = null;
    this.showAttract();
  }

  clearContainer(container) {
    for (const child of container.removeChildren()) child.destroy({ children: true });
  }
  clearLayers() {
    this.audio.stopAll();
    this.clearContainer(this.gameLayer);
    this.clearContainer(this.uiLayer);
    this.noticeContainer = null;
  }
  showAttract() {
    this.clearLayers();
    this.gameLayer.addChild(this.selectedGame.renderAttract(this.api, { game: this.selectedGame, controls: this.input.controlLabels }));
  }
  showGameOver() {
    this.clearContainer(this.uiLayer);
    this.noticeContainer = null;
    this.uiLayer.addChild(this.selectedGame.renderGameOver(this.api, {
      result: this.result, playerCount: this.playerCount, controls: this.input.controlLabels,
    }));
  }
  showNotice(message) {
    if (!this.noticeContainer || this.noticeContainer.destroyed) {
      this.noticeContainer = new Container();
      this.noticeText = new TvCaption({ fontSize: 15, maxWidth: this.api.hudSafeArea.width - 16 });
      this.noticeText.position.set(this.api.width / 2, this.api.hudSafeArea.bottom - 32);
      this.noticeContainer.addChild(this.noticeText);
      this.uiLayer.addChild(this.noticeContainer);
    }
    this.noticeText.text = message;
    this.noticeContainer.visible = true;
    this.noticeTime = 3;
  }

  async captureContext() {
    const game = this.selectedGame;
    const context = {
      mode: "game", gameId: game.id, gameTitle: game.title, revision: game.revision,
      state: { phase: this.state, playerCount: this.playerCount, stateVersion: game.stateVersion ?? 1,
        game: this.state === "attract" ? null : structuredClone(game.captureState()) },
      screenshot: null,
    };
    try { context.screenshot = await this.app.renderer.extract.base64({ target: this.screenLayer, format: "png" }); }
    catch (error) { context.captureError = error.message; }
    return context;
  }

  async reloadGame(event) {
    if (event.gameId !== this.selectedGame.id) return { status: "not-active" };
    if (event.revision && event.revision === this.selectedGame.revision) return { status: "unchanged" };
    const sequence = ++this.reloadSequence;
    try {
      const game = await this.loadGame(event.gameId, event.revision);
      if (sequence !== this.reloadSequence || event.gameId !== this.selectedGame.id) return { status: "superseded" };
      this.pendingReload?.resolve({ status: "superseded" });
      return new Promise((resolve) => { this.pendingReload = { game, event, resolve }; });
    } catch (error) {
      this.showNotice(`UPDATE NOT APPLIED: ${error.message}`);
      return { status: "error", message: error.message };
    }
  }

  activateReplacement(next, event = {}) {
    const previous = this.selectedGame;
    if (next.id !== previous.id) return { status: "not-active" };
    let scene;
    let resultScene;
    let phase = "prepare";
    try {
      next.configure?.(next.config ?? {}, this.api);
      if (this.state === "attract") {
        scene = next.renderAttract(this.api, { game: next, controls: this.input.controlLabels });
      } else {
        phase = "restart";
        if (event.requiresRestart) throw new Error("Cette modification demande de redémarrer la partie.");
        if (next.maxPlayers < this.playerCount) throw new Error("Le nombre de joueurs a changé.");
        phase = "mount";
        scene = next.mount(this.api);
        phase = "state";
        transferLiveState(previous, next, this.api);
        phase = "results";
        if (this.state === "gameover") resultScene = next.renderGameOver(this.api, {
          result: this.result, playerCount: this.playerCount, controls: this.input.controlLabels,
        });
      }
    } catch (error) {
      scene?.destroy({ children: true });
      resultScene?.destroy({ children: true });
      if (!["state", "restart"].includes(phase)) {
        this.showNotice(`UPDATE NOT APPLIED: ${error.message}`);
        return { status: "error", message: error.message };
      }
      this.offerRestart(next, error.message);
      return { status: "restart-required", message: error.message };
    }
    this.dismissRestart();
    this.clearLayers();
    previous.destroy?.();
    this.games[this.selectedIndex] = next;
    this.gameLayer.addChild(scene);
    if (resultScene) this.uiLayer.addChild(resultScene);
    this.showNotice("UPDATED");
    return { status: "applied", revision: next.revision };
  }

  offerRestart(game, reason) {
    this.dismissRestart();
    this.restartCandidate = game;
    this.restartReason = reason;
    this.restartPanel = new TvCaption({ fontSize: 17, maxWidth: this.api.hudSafeArea.width - 16 });
    this.restartPanel.text = "RESTART REQUIRED\nSTART · RESTART     ESC · LATER";
    this.restartPanel.position.set(this.api.width / 2, this.api.hudSafeArea.bottom - 32);
    this.systemLayer.addChild(this.restartPanel);
  }
  dismissRestart() {
    this.restartPanel?.destroy({ children: true });
    this.restartPanel = null;
    this.restartCandidate = null;
  }
  restartWithCandidate() {
    if (!this.restartCandidate) return;
    const next = this.restartCandidate;
    const previous = this.selectedGame;
    this.dismissRestart();
    previous.destroy?.();
    this.games[this.selectedIndex] = next;
    this.startGame(this.playerCount || 1);
    this.input.reset();
  }
  updateStatus() {
    if (!this.statusNode) return;
    this.statusNode.textContent = `${this.selectedGame.title} · ${this.state} · ${this.playerCount}P · CODEX ${this.input.controlLabels.codex} · EXIT ${this.input.controlLabels.exit}`;
    Object.assign(this.statusNode.dataset, { state: this.state, game: this.selectedGame.id, players: String(this.playerCount) });
  }
  destroy() {
    this.app.ticker.remove(this.tick);
    if (this.ownsInput) this.input.destroy();
    this.dismissRestart();
    this.clearLayers();
    this.selectedGame.destroy?.();
    this.audio.dispose();
    this.screenLayer.destroy({ children: true });
  }
}
