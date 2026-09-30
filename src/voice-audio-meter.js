const WAVEFORM_SIZE = 64;

/** Actual PCM samples only: this measures audio, it does not recognize speech. */
export function measureSamples(samples) {
  let sum = 0;
  for (const sample of samples) sum += Number.isFinite(sample) ? sample : 0;
  const mean = samples.length ? sum / samples.length : 0;
  let energy = 0;
  for (const sample of samples) energy += ((Number.isFinite(sample) ? sample : 0) - mean) ** 2;
  const rms = samples.length ? Math.sqrt(energy / samples.length) : 0;
  const waveform = Array.from({ length: WAVEFORM_SIZE }, (_, index) => {
    const sample = samples[Math.floor(index * samples.length / WAVEFORM_SIZE)] || 0;
    return Math.max(-1, Math.min(1, sample - mean));
  });
  return { rms, level: Math.min(1, rms * 6), waveform };
}

/** Owns only its Web Audio graph, never the caller's tracks or audible playback. */
export class VoiceAudioMeter {
  constructor({
    onActivity = () => {},
    AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
    requestFrame = (callback) => requestAnimationFrame(callback),
    cancelFrame = (id) => cancelAnimationFrame(id),
  } = {}) {
    if (!AudioContextClass) throw new Error("Ce navigateur ne permet pas de vérifier le signal du microphone.");
    this.context = new AudioContextClass();
    this.onActivity = onActivity;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.input = null;
    this.output = null;
    this.connected = false;
    this.microphone = "permission";
    this.signalDetected = false;
    this.closed = false;
    this.lastFrameAt = -Infinity;
    this.tick = (timestamp) => {
      if (this.closed) return;
      if (timestamp - this.lastFrameAt >= 1000 / 30) {
        this.lastFrameAt = timestamp;
        this.onActivity(this.sample());
      }
      this.frame = this.requestFrame(this.tick);
    };
    this.frame = this.requestFrame(this.tick);
  }

  resume() { return this.context.resume(); }

  _attach(kind, stream) {
    this[kind]?.source.disconnect();
    this[kind]?.analyser.disconnect();
    this[kind] = null;
    if (!stream || this.closed) return;
    const source = this.context.createMediaStreamSource(stream);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    // Deliberately no destination: input must never echo and output already
    // plays through the sole remote <audio> element. Analyser outputs may be unconnected.
    this[kind] = { source, analyser, stream, samples: new Float32Array(analyser.fftSize), level: 0 };
  }

  setInputStream(stream) {
    this.signalDetected = false;
    this._attach("input", stream);
    this.microphone = stream ? "ready" : "off";
  }

  setOutputStream(stream) { this._attach("output", stream); }
  setConnected(connected) { this.connected = Boolean(connected); }

  _measure(node, enabled) {
    if (!node || !enabled || this.context.state !== "running") return { rms: 0, level: 0, waveform: Array(WAVEFORM_SIZE).fill(0) };
    node.analyser.getFloatTimeDomainData(node.samples);
    const value = measureSamples(node.samples);
    // Smooth only the display envelope; activity and waveform remain actual samples.
    node.level = value.level >= node.level ? value.level : node.level * 0.72;
    return { ...value, level: node.level };
  }

  sample() {
    const tracks = this.input?.stream.getAudioTracks() || [];
    if (tracks.length) {
      this.microphone = tracks.every((track) => track.readyState === "ended") ? "ended"
        : tracks.every((track) => track.muted || !track.enabled || track.readyState === "ended") ? "muted" : "ready";
    }
    const input = this._measure(this.input, this.microphone === "ready");
    const output = this._measure(this.output, true);
    const inputActive = input.rms > 0.008;
    const outputActive = output.rms > 0.003;
    this.signalDetected ||= inputActive;
    return {
      inputLevel: input.level, outputLevel: output.level,
      inputWaveform: input.waveform, outputWaveform: output.waveform,
      inputActive, outputActive, inputRms: input.rms, outputRms: output.rms,
      microphone: this.microphone, connected: this.connected,
      signalDetected: this.signalDetected, audioContextState: this.context.state,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelFrame(this.frame);
    for (const kind of ["input", "output"]) {
      this[kind]?.source.disconnect();
      this[kind]?.analyser.disconnect();
      this[kind] = null;
    }
    // The stream owner stops tracks. In particular, don't stop remote tracks here.
    this.context.close().catch(() => {});
  }
}
