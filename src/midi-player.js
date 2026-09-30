import { decodeMidi } from "./midi.js";

const bellWaves = new WeakMap();

// Lightweight retro interpretation of GM programs, not a General MIDI sound bank.
// A maximum of 12 simultaneous oscillators; scheduling uses the audio clock,
// independently of Three/Pixi frames. Quiet envelopes avoid clicks and clipping.
export function scheduleMidiNote(context, output, note, when) {
  const oscillator = context.createOscillator(), envelope = context.createGain();
  const bass = note.program >= 32 && note.program < 40;
  const bell = note.program >= 8 && note.program < 16;
  const pad = note.program >= 88 && note.program < 104;
  const drum = note.channel === 9;
  oscillator.type = bass ? "triangle" : bell || pad || drum ? "sine" : note.program >= 80 && note.program < 88 ? "square" : "triangle";
  if (bell) {
    if (!bellWaves.has(context)) bellWaves.set(context, context.createPeriodicWave(new Float32Array(6), new Float32Array([0, 1, .16, .1, .02, .025])));
    oscillator.setPeriodicWave(bellWaves.get(context));
  }
  const frequency = 440 * 2 ** ((note.pitch - 69) / 12);
  oscillator.frequency.setValueAtTime(drum ? 140 : frequency, when);
  if (drum) oscillator.frequency.exponentialRampToValueAtTime(45, when + .12);
  const length = drum ? .13 : Math.max(.04, note.duration);
  const attack = Math.min(pad ? .16 : .012, length / 3);
  const release = pad ? .16 : bell ? .22 : .06;
  const peak = note.velocity * (oscillator.type === "square" ? .10 : bass ? .28 : .23);
  const gain = envelope.gain;
  gain.setValueAtTime(0, when);
  gain.linearRampToValueAtTime(peak, when + attack);
  gain.exponentialRampToValueAtTime(Math.max(.0001, peak * (bell || drum ? .10 : pad ? .8 : .45)), when + length);
  gain.linearRampToValueAtTime(0, when + length + release);
  oscillator.connect(envelope); envelope.connect(output);
  oscillator.start(when); oscillator.stop(when + length + release + .01);
  return { oscillator, envelope, end: when + length + release };
}

export class MidiPlayer {
  constructor({ active = true, contextFactory = () => new AudioContext(), fetchFile = (...args) => globalThis.fetch(...args),
    document: doc = globalThis.document, target = globalThis.window } = {}) {
    Object.assign(this, { active, contextFactory, fetchFile, doc, target });
    this.voices = new Set();
    this.sequence = 0;
    this.volume = .22;
    this.ducked = false;
    this.wake = () => { void this.reconcile(); };
    this.visibility = () => { if (doc.hidden) this.halt(); else this.wake(); };
    target?.addEventListener("pointerdown", this.wake);
    target?.addEventListener("keydown", this.wake);
    doc?.addEventListener("visibilitychange", this.visibility);
  }

  async play(url, { volume = .22, loop = true } = {}) {
    if (this.disposed) return false;
    this.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : .22;
    this.updateGain();
    if (this.url === String(url) && this.loop === loop) return this.loading;
    this.stop();
    this.url = String(url); this.loop = loop;
    const sequence = this.sequence;
    // Try resume synchronously with a user gesture, before awaiting the fetch.
    this.wake();
    this.loading = (async () => {
      try {
        const response = await this.fetchFile(this.url);
        if (!response.ok) throw new Error(`MIDI HTTP ${response.status}`);
        const data = await response.arrayBuffer();
        if (sequence !== this.sequence || this.disposed) return false;
        this.song = decodeMidi(data);
        await this.reconcile();
        return true;
      } catch (error) {
        if (sequence === this.sequence) console.warn("Musique indisponible :", error.message);
        return false; // An optional soundtrack never breaks the game loop.
      }
    })();
    return this.loading;
  }

  async reconcile() {
    if (this.disposed || !this.active || this.doc?.hidden || !this.url) return;
    try {
      if (!this.context) {
        this.context = this.contextFactory();
        this.output = this.context.createGain();
        this.output.gain.value = 0;
        this.output.connect(this.context.destination);
        this.updateGain();
      }
      if (this.context.state === "suspended") await this.context.resume();
      if (this.disposed || !this.active || this.doc?.hidden || !this.song || this.timer || this.finished || this.context.state !== "running") return;
      this.origin = this.context.currentTime + .06;
      this.index = 0;
      this.timer = setInterval(() => this.schedule(), 50);
      this.schedule();
    } catch { /* Autoplay denied/unsupported: retry on the next user gesture. */ }
  }

  schedule() {
    const now = this.context.currentTime;
    // Skip elapsed loops after an OS stall instead of playing a burst of notes.
    if (this.loop && now - this.origin >= this.song.duration) {
      this.origin += Math.floor((now - this.origin) / this.song.duration) * this.song.duration;
      this.index = 0;
    }
    const { notes, duration } = this.song;
    while (true) {
      if (this.index >= notes.length) {
        if (!this.loop) { clearInterval(this.timer); this.timer = null; this.finished = true; return; }
        this.origin += duration; this.index = 0;
      }
      const note = notes[this.index], when = this.origin + note.time;
      if (when > now + .15) break;
      this.index++;
      if (when < now - .03) continue;
      const start = Math.max(now, when);
      if ([...this.voices].filter(voice => voice.end > start).length >= 12) continue;
      const voice = scheduleMidiNote(this.context, this.output, note, start);
      this.voices.add(voice);
      voice.oscillator.onended = () => { voice.oscillator.disconnect(); voice.envelope.disconnect(); this.voices.delete(voice); };
    }
  }

  updateGain() {
    if (!this.output) return;
    this.output.gain.setTargetAtTime(this.volume * (this.ducked ? .12 : 1), this.context.currentTime, .10);
  }
  setDucked(ducked) { this.ducked = Boolean(ducked); this.updateGain(); }
  setActive(active) { this.active = Boolean(active); if (this.active) this.wake(); else this.halt(); }
  halt() {
    clearInterval(this.timer); this.timer = null;
    const now = this.context?.currentTime ?? 0;
    for (const voice of this.voices) {
      voice.envelope.gain.cancelScheduledValues(now);
      voice.envelope.gain.setTargetAtTime(0, now, .008);
      voice.oscillator.stop(now + .04);
    }
    this.voices.clear();
  }
  stop() { this.sequence++; this.halt(); this.url = null; this.song = null; this.finished = false; }
  dispose() {
    this.disposed = true; this.stop();
    this.target?.removeEventListener("pointerdown", this.wake);
    this.target?.removeEventListener("keydown", this.wake);
    this.doc?.removeEventListener("visibilitychange", this.visibility);
    this.output?.disconnect();
    void this.context?.close().catch(() => {});
  }
}
