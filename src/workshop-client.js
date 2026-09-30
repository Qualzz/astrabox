import { VoiceAudioMeter } from "./voice-audio-meter.js";

const SESSION_KEY = "arcade:codex:session:";

/** Browser-to-local-harness client. Voice uses the real Codex WebRTC transport. */
export class WorkshopClient extends EventTarget {
  constructor({ getGameContext = () => ({}), onGameUpdated = () => {} } = {}) {
    super();
    this.getGameContext = getGameContext;
    this.onGameUpdated = onGameUpdated;
    this.session = null;
    this.sessionGameId = null;
    this.sessionPromise = null;
    this.sessionEvents = null;
    this.globalEvents = null;
    this.seenRevisions = new Map();
    this.seenCaptureRequests = new Set();
    this.controllers = new Set();
    this.voiceGeneration = 0;
    this.voiceStarting = false;
    this.peer = null;
    this.stream = null;
    this.audio = null;
    this.channel = null;
    this.audioMeter = null;
    this.voiceAttemptAt = 0;
    this.voiceConnectedAt = 0;
    this.voiceDiagnostic = null;
    this.voicePlaybackBlocked = false;
    this.pendingInputAt = 0;
    this.lastInputAt = 0;
    this.inputEpisodeActive = false;
    this.inputAcknowledged = false;
    this.trackListeners = [];
    this.voiceAbort = null;
    this.disposed = false;
    this.workState = "idle";
    this.workshopStates = new Map();
    this.onPageHide = () => this.dispose();
    globalThis.addEventListener?.("pagehide", this.onPageHide);
    if (typeof EventSource !== "undefined") {
      this.globalEvents = new EventSource("/api/events");
      this.globalEvents.onmessage = (event) => this._receive(event.data);
      this.globalEvents.addEventListener("game-updated", (event) => this._receive(event.data));
      this.globalEvents.addEventListener("game-thumbnail-updated", (event) => this._receive(event.data));
      this.globalEvents.addEventListener("workshop-status", (event) => this._receive(event.data));
      this.globalEvents.addEventListener("capture-request", (event) => this._receive(event.data));
    }
    // Restores robot activity after navigation without starting/resuming an AI session.
    this._fetch("/api/workshop/state").then(({ sessions = [] }) => {
      for (const session of sessions) {
        if (!this.workshopStates.has(session.sessionId)) this._receive({ ...session, type: "workshop-status" });
      }
    }).catch(() => { /* An idle hub remains usable when its harness is offline. */ });
  }

  get voiceActive() {
    return Boolean(this.voiceStarting || this.peer || this.stream);
  }

  _emit(type, detail) {
    if (!this.disposed) this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _status(state, message) {
    this._emit("status", { state, message });
  }

  async _fetch(path, body, { timeoutMs = 30_000, signal, keepalive = false } = {}) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        signal: controller.signal,
        keepalive,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(typeof data?.error === "string" ? data.error : data?.error?.message || `Le harness a répondu ${response.status}.`);
        error.status = response.status;
        throw error;
      }
      if (!data) throw new Error("Le harness n’a pas renvoyé une réponse valide.");
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(signal?.aborted ? "Connexion vocale annulée." : "Le harness ne répond pas. Vérifie que le serveur est démarré.");
      throw error;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }

  async _context() {
    return (await this.getGameContext()) || {};
  }

  async _ensureSession(context) {
    if (this.disposed) throw new Error("La session est fermée.");
    const gameId = context.gameId || null;
    if (this.sessionPromise) {
      await this.sessionPromise;
      return this._ensureSession(context);
    }
    this.sessionPromise = (async () => {
      let sessionId;
      // Same conversation in the menu and every game. Always refresh its view
      // context, including when we already know the session ID.
      const storageKey = SESSION_KEY + "assistant";
      try { sessionId = sessionStorage.getItem(storageKey); } catch { /* Storage may be disabled. */ }
      sessionId ||= this.session?.sessionId;
      const session = await this._fetch("/api/workshop/session", { mode: "assistant", context, ...(sessionId ? { sessionId } : {}) });
      if (this.disposed) throw new Error("La session est fermée.");
      if (!session.sessionId || !session.threadId) throw new Error("La session Codex est incomplète.");
      this.session = session;
      this.sessionGameId = gameId;
      this.workState = this.workshopStates.get(session.sessionId)?.state || "idle";
      try { sessionStorage.setItem(storageKey, session.sessionId); } catch { /* Session works without storage. */ }
      if (this.eventsSessionId !== session.sessionId) {
        this.sessionEvents?.close();
        this.sessionEvents = new EventSource(`/api/workshop/${encodeURIComponent(session.sessionId)}/events`);
        this.eventsSessionId = session.sessionId;
        this.sessionEvents.onmessage = (event) => this._receive(event.data);
        this.sessionEvents.onerror = () => this._status("reconnecting", "Reconnexion au harness…");
      }
      return session;
    })();
    try { return await this.sessionPromise; } finally { this.sessionPromise = null; }
  }

  async _receive(raw) {
    if (this.disposed) return;
    let event;
    try { event = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
    if (!event || typeof event.type !== "string") return;
    const otherSession = event.sessionId && this.session?.sessionId && event.sessionId !== this.session.sessionId;
    const beforeVoiceAttempt = this.voiceAttemptAt > 0 && Number.isFinite(event.timestamp) && event.timestamp < this.voiceAttemptAt;
    // Session SSE replays status/message history. Old statuses are not commands
    // for a newly starting call. Apply the same guard to a late queued close,
    // without discarding conversation history or published-game notifications.
    if (["status", "voice-closed"].includes(event.type) && (otherSession || beforeVoiceAttempt)) return;
    try {
      if (event.type === "workshop-status") {
        if (event.sessionId) this.workshopStates.set(event.sessionId, event);
        if (event.sessionId && event.sessionId === this.session?.sessionId) this.workState = event.state;
        this._emit(event.type, event);
      } else if (event.type === "capture-request") {
        // The voice session can live on a phone while this page only runs the
        // cartridge. Route its capture back without opening a local AI session.
        const sessionId = event.sessionId || this.session?.sessionId;
        if (!sessionId || typeof event.requestId !== "string" || !event.requestId) return;
        const captureKey = `${sessionId}:${event.requestId}`;
        if (this.seenCaptureRequests.has(captureKey)) return;
        this.seenCaptureRequests.add(captureKey);
        if (this.seenCaptureRequests.size > 128) this.seenCaptureRequests.delete(this.seenCaptureRequests.values().next().value);
        const context = await this._context();
        const requestedGameId = event.gameId ?? (sessionId === this.session?.sessionId ? this.sessionGameId : null);
        if (this.disposed || !requestedGameId || requestedGameId !== context.gameId) return;
        await this._fetch(`/api/workshop/${encodeURIComponent(sessionId)}/context`, { context, requestId: event.requestId });
      } else if (event.type === "game-updated") {
        if (event.gameId && event.sessionId) {
          try { sessionStorage.setItem(SESSION_KEY + event.gameId, event.sessionId); } catch { /* Optional persistence. */ }
        }
        const revision = event.revision;
        if (revision != null && this.seenRevisions.get(event.gameId) === revision) return;
        if (revision != null) this.seenRevisions.set(event.gameId, revision);
        await this.onGameUpdated(event);
        this._emit(event.type, event);
      } else if (event.type === "game-thumbnail-updated") {
        this._emit(event.type, event);
      } else if (event.type === "voice-closed") {
        this._releaseVoice();
        this._emit(event.type, event);
      } else if (["status", "message", "transcript"].includes(event.type)) {
        if (event.type === "status") this.workState = event.state;
        if (event.type === "transcript" && !otherSession && event.role === "user" && event.text?.trim() && this.voiceConnectedAt &&
            (!event.timestamp || event.timestamp >= this.voiceConnectedAt)) {
          this._voiceInputAcknowledged();
          if (event.done) this._emit("voice-state", { state: "heard" });
        }
        this._emit(event.type, event);
      }
    } catch (error) {
      this._status("error", error.message);
    }
  }

  async sendText(text) {
    if (typeof text !== "string" || !text.trim()) return;
    try {
      const context = await this._context();
      const session = await this._ensureSession(context);
      return await this._fetch(`/api/workshop/${encodeURIComponent(session.sessionId)}/message`, { text: text.trim(), context });
    } catch (error) {
      this._status("error", error.message);
      throw error;
    }
  }

  _diagnostic(code, message = "") {
    if (this.voiceDiagnostic === code) return;
    this.voiceDiagnostic = code;
    this._emit("voice-diagnostic", { code, message });
  }

  _voiceInputAcknowledged() {
    this.pendingInputAt = 0;
    this.inputAcknowledged = true;
    if (this.voiceDiagnostic === "awaiting-service") this._diagnostic(null);
  }

  _onVoiceActivity(activity) {
    this._emit("voice-activity", activity);
    if (!this.voiceConnectedAt) return;
    const now = Date.now();
    if (activity.inputActive) {
      if (!this.inputEpisodeActive) this.pendingInputAt ||= now;
      this.inputEpisodeActive = true;
      this.lastInputAt = now;
    } else if (now - this.lastInputAt > 450) this.inputEpisodeActive = false;
    if (activity.microphone === "muted") this._diagnostic("microphone-muted", "Micro muet — vérifie le micro du navigateur.");
    else if (this.voicePlaybackBlocked) this._diagnostic("playback-blocked", "START · ACTIVER LE SON");
    else if (activity.audioContextState !== "running") this._diagnostic("audio-suspended", "START · ACTIVER LE SON");
    else if (!activity.signalDetected && !this.inputAcknowledged && now - this.voiceConnectedAt > 10_000) this._diagnostic("no-input", "Aucun signal micro — parle pour tester.");
    else if (this.pendingInputAt && now - this.pendingInputAt > 12_000 && now - this.lastInputAt > 1_500) {
      this._diagnostic("awaiting-service", "Signal micro reçu ici — réponse vocale en attente.");
    } else if (this.voiceDiagnostic) this._diagnostic(null);
  }

  _receiveVoiceEvent(event) {
    if (!this.voiceActive || !event || typeof event.type !== "string") return;
    // Automatic turn detection: never commit an audio buffer or stop the call
    // to send a sentence. Stopping voice is only for ending the conversation.
    if (event.type === "error") {
      this.stopVoice({ silent: true }).catch(() => {});
      this._status("error", event.error?.message || "Le service vocal a signalé une erreur. Le microphone est coupé.");
    } else if (event.type === "input_transcript.added") {
      // Native Codex Realtime v3. This event was observed on the actual data
      // channel; unlike a local volume level, it acknowledges server reception.
      if (typeof event.item?.text !== "string" || !event.item.text.trim()) return;
      this._voiceInputAcknowledged();
      this._emit("voice-state", { state: "heard", inputAcknowledged: true });
    } else if (event.type === "turn.created") {
      this._emit("voice-state", { state: event.turn?.role === "user" ? "listening" : "processing" });
    } else if (event.type === "turn.done") {
      // Turn completion is not proof of audio playback. The analyser is the
      // authority for the speaking animation, including any buffered tail.
      if (event.turn?.role === "user" && typeof event.turn.transcript === "string" && event.turn.transcript.trim()) this._voiceInputAcknowledged();
      this._emit("voice-state", { state: event.turn?.role === "user" ? "processing" : "listening" });
    } else if (event.type === "input_audio_buffer.speech_started") {
      this._voiceInputAcknowledged();
      this._emit("voice-state", { state: "listening", inputAcknowledged: true });
    } else if (event.type === "input_audio_buffer.speech_stopped") {
      this._voiceInputAcknowledged();
      this._emit("voice-state", { state: "processing" });
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      this._voiceInputAcknowledged();
      this._emit("voice-state", { state: "heard" });
    } else if (event.type === "output_audio_buffer.started") {
      this._emit("voice-state", { state: "speaking" });
    } else if (["output_audio_buffer.stopped", "output_audio_buffer.cleared"].includes(event.type)) {
      this._emit("voice-state", { state: "listening" });
    }
  }

  async resumeAudio() {
    if (!this.voiceActive) return;
    try {
      // Both calls begin synchronously in the START gesture, before any await.
      const promises = [this.audioMeter?.resume()];
      if (this.audio?.srcObject) promises.push(this.audio.play());
      await Promise.all(promises);
      this.voicePlaybackBlocked = false;
      if (["audio-suspended", "playback-blocked"].includes(this.voiceDiagnostic)) this._diagnostic(null);
    } catch {
      this.voicePlaybackBlocked = true;
      this._diagnostic("playback-blocked", "START · ACTIVER LE SON");
    }
  }

  async startVoice() {
    if (this.disposed) return;
    if (this.voiceActive) return this.resumeAudio();
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      const error = new Error("Ce navigateur ne permet pas le vocal WebRTC. Utilise HTTPS ou localhost et autorise le microphone. Le mode texte reste disponible.");
      this._status("error", error.message);
      throw error;
    }
    const generation = ++this.voiceGeneration;
    this.voiceAttemptAt = Date.now();
    this.voiceStarting = true;
    this.voiceAbort = new AbortController();
    const signal = this.voiceAbort.signal;
    const current = () => !this.disposed && generation === this.voiceGeneration && !signal.aborted;
    if (!this._workActive()) this._status("connecting", "Connexion au vocal Codex…");
    this._emit("voice-state", { state: "connecting" });
    let permissionTimer;
    try {
      // Create/resume during START, not after asynchronous permission/network
      // calls which can lose the browser's user-activation grant.
      this.audioMeter = new VoiceAudioMeter({ onActivity: (activity) => {
        if (current()) this._onVoiceActivity(activity);
      } });
      this.audioMeter.resume().catch(() => { /* START can explicitly retry audio. */ });
      // Request only from the caller's explicit button/START action, never on page load.
      const microphone = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      microphone.then((stream) => { if (!current()) stream.getTracks().forEach((track) => track.stop()); }, () => {});
      const stream = await Promise.race([
        microphone,
        new Promise((_, reject) => { permissionTimer = setTimeout(() => reject(new Error("Autorisation du microphone en attente. Réessaie après avoir choisi dans le navigateur.")), 45_000); }),
        new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Connexion vocale annulée.")), { once: true })),
      ]);
      clearTimeout(permissionTimer);
      if (!current()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      if (!stream.getAudioTracks().some((track) => track.readyState === "live")) throw new Error("Le navigateur n’a fourni aucun microphone actif.");
      this.audioMeter.setInputStream(stream);
      const context = await this._context();
      if (!current()) return;
      const session = await this._ensureSession(context);
      if (!current()) return;
      const peer = this.peer = new RTCPeerConnection();
      const audio = this.audio = document.createElement("audio");
      audio.autoplay = true;
      audio.setAttribute("playsinline", "");
      peer.ontrack = ({ streams, track }) => {
        if (!current()) return;
        audio.srcObject = streams[0] || new MediaStream([track]);
        this.audioMeter.setOutputStream(audio.srcObject);
        audio.play().catch(() => {
          if (!current()) return;
          this.voicePlaybackBlocked = true;
          this._diagnostic("playback-blocked", "START · ACTIVER LE SON");
        });
      };
      stream.getTracks().forEach((track) => {
        peer.addTrack(track, stream);
        const ended = () => {
          if (!current()) return;
          this._emit("voice-activity", { ...this.audioMeter.sample(), microphone: "ended" });
          this.stopVoice({ silent: true }).catch(() => {});
          this._status("error", "Le microphone a été déconnecté ou son autorisation a été retirée.");
        };
        const changed = () => { if (current()) this._onVoiceActivity(this.audioMeter.sample()); };
        for (const [name, listener] of [["ended", ended], ["mute", changed], ["unmute", changed]]) {
          track.addEventListener(name, listener);
          this.trackListeners.push(() => track.removeEventListener(name, listener));
        }
      });
      const channel = this.channel = peer.createDataChannel("oai-events");
      channel.onmessage = ({ data }) => {
        let event;
        try { event = JSON.parse(data); } catch { return; }
        // Transcripts and Codex tool execution stay on SSE, avoiding duplicates.
        this._receiveVoiceEvent(event);
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      // STOP cuts local audio immediately; a fast reopen must not race the
      // previous server stop and accidentally tear down the new connection.
      await this.voiceStopPending;
      if (!current()) return;
      const answer = await this._fetch(`/api/workshop/${encodeURIComponent(session.sessionId)}/voice/start`, { sdp: peer.localDescription.sdp }, { timeoutMs: 45_000, signal });
      if (!current()) return;
      if (typeof answer.sdp !== "string" || !answer.sdp.startsWith("v=")) throw new Error("Codex n’a pas renvoyé de réponse WebRTC valide. Le vocal expérimental peut être indisponible pour cette version ou ce compte.");
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error("La connexion audio WebRTC n’a pas abouti.")); }, 20_000);
        const cleanup = () => { clearTimeout(timer); peer.removeEventListener("connectionstatechange", changed); signal.removeEventListener("abort", aborted); };
        const aborted = () => { cleanup(); reject(new Error("Connexion vocale annulée.")); };
        const changed = () => {
          if (peer.connectionState === "connected") { cleanup(); resolve(); }
          else if (["failed", "closed"].includes(peer.connectionState)) { cleanup(); reject(new Error("La connexion audio WebRTC a été interrompue.")); }
        };
        peer.addEventListener("connectionstatechange", changed);
        signal.addEventListener("abort", aborted, { once: true });
        changed();
      });
      if (!current()) return;
      this.voiceStarting = false;
      this.voiceConnectedAt = Date.now();
      this.audioMeter.setConnected(true);
      peer.onconnectionstatechange = () => {
        if (current() && ["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          this.stopVoice({ silent: true }).catch(() => {});
          this._status("error", "La connexion vocale a été interrompue. Le microphone est coupé.");
        }
      };
      if (!this._workActive()) this._status("listening", "Parle, puis fais une pause. Codex répond automatiquement.");
      this._emit("voice-state", { state: "listening" });
    } catch (error) {
      if (!current()) return;
      await this.stopVoice({ silent: true }).catch(() => {});
      const message = error.name === "NotAllowedError" ? "Microphone refusé. Autorise-le dans le navigateur ; le mode texte reste disponible." : error.message;
      this._status("error", message);
      throw new Error(message);
    } finally {
      clearTimeout(permissionTimer);
    }
  }

  _releaseVoice() {
    this.voiceGeneration += 1;
    this.voiceStarting = false;
    this.voiceConnectedAt = 0;
    this.pendingInputAt = 0;
    this.lastInputAt = 0;
    this.inputEpisodeActive = false;
    this.inputAcknowledged = false;
    this.voicePlaybackBlocked = false;
    this.voiceAbort?.abort();
    this.voiceAbort = null;
    for (const removeListener of this.trackListeners) removeListener();
    this.trackListeners = [];
    this.audioMeter?.close();
    this.audioMeter = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.close();
    }
    this.peer = null;
    if (this.channel) this.channel.onmessage = null;
    this.channel?.close();
    this.channel = null;
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    this.audio = null;
    this._diagnostic(null);
    this._emit("voice-activity", { inputLevel: 0, outputLevel: 0, inputWaveform: Array(64).fill(0), outputWaveform: Array(64).fill(0), inputActive: false, outputActive: false, microphone: "off", connected: false, signalDetected: false });
    this._emit("voice-state", { state: "off" });
  }

  async stopVoice({ silent = false } = {}) {
    const hadVoice = this.voiceActive;
    this._releaseVoice();
    const generation = this.voiceGeneration;
    if (this.session && hadVoice) {
      const pending = this._fetch(`/api/workshop/${encodeURIComponent(this.session.sessionId)}/voice/stop`, {}, { timeoutMs: 5_000, keepalive: true });
      this.voiceStopPending = pending;
      try { await pending; }
      finally { if (this.voiceStopPending === pending) this.voiceStopPending = null; }
    }
    if (generation === this.voiceGeneration && !silent && !this._workActive()) this._status("idle", "Micro coupé. La conversation est conservée.");
  }

  _workActive() {
    return ["building", "testing", "applying", "working"].includes(this.workState);
  }

  async interrupt() {
    if (!this.session) return;
    return this._fetch(`/api/workshop/${encodeURIComponent(this.session.sessionId)}/interrupt`, {});
  }

  dispose() {
    if (this.disposed) return;
    const hadVoice = this.voiceActive;
    this.disposed = true;
    this._releaseVoice();
    this.globalEvents?.close();
    this.sessionEvents?.close();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    globalThis.removeEventListener?.("pagehide", this.onPageHide);
    if (hadVoice && this.session) {
      fetch(`/api/workshop/${encodeURIComponent(this.session.sessionId)}/voice/stop`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "same-origin", keepalive: true,
        signal: AbortSignal.timeout(3_000),
      }).catch(() => {});
    }
  }
}
