import { MidiPlayer } from "./midi-player.js";

export class ArcadeAudio {
  constructor({ musicActive = true } = {}) {
    this.sound = null;
    this.loading = null;
    this.musicActive = musicActive;
    this.musicDucked = false;
  }

  async engine() {
    if (!this.loading) {
      this.loading = import("@pixi/sound").then(({ sound }) => {
        this.sound = sound;
        return sound;
      });
    }
    return this.loading;
  }

  async add(alias, source) {
    const sound = await this.engine();
    // A live code replacement reuses the same effect bank instead of allocating
    // another decoded buffer on every mount. Include the asset id in the alias.
    if (sound.exists(alias)) return sound.find(alias);
    return sound.add(alias, source);
  }

  async play(alias, options) {
    const sound = await this.engine();
    return sound.play(alias, options);
  }

  stopAll() {
    this.sound?.stopAll();
    this.stopMusic();
  }

  music(url, options) {
    if (this.disposed) return Promise.resolve(false);
    if (!this.midi) {
      this.midi = new MidiPlayer({ active: this.musicActive });
      this.midi.setDucked(this.musicDucked);
    }
    return this.midi.play(url, options);
  }
  stopMusic() { this.midi?.stop(); }
  setMusicActive(active) { this.musicActive = Boolean(active); this.midi?.setActive(active); }
  setMusicDucked(ducked) { this.musicDucked = Boolean(ducked); this.midi?.setDucked(ducked); }
  dispose() { this.disposed = true; this.stopAll(); this.midi?.dispose(); }
}
