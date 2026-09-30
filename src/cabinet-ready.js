// One minute of decorative filling, not a measured Codex completion percentage.
// Keep the last LEDs unlit until an actual publication arrives.
const WORK_STATES = new Set(["thinking", "building", "working", "testing", "applying"]);
export const READY_FILL_SECONDS = 60;
export const READY_FALL_SECONDS = 2.4;
export const READY_CONFIRM_SECONDS = 2.8;
const WAITING_FILL = .97;
// Match the 2.1% CSS gap and the letters' position inside the glass. Every
// glyph and falling grain uses this same whole-column coordinate system.
const TUBE_HEIGHT = (1 - 4 * .021) / 5;
const TUBE_STEP = TUBE_HEIGHT + .021;
const LETTER_TOP = TUBE_HEIGHT * (.07 + .82 * .29);
const LETTER_HEIGHT = TUBE_HEIGHT * .82 * .5;
const COLUMN_HEIGHT = 4 * TUBE_STEP + LETTER_HEIGHT;
export const READY_GLYPHS = Object.freeze({
  R: ["11110", "10001", "10001", "10001", "11110", "10100", "10010", "10001", "10001"],
  E: ["11111", "10000", "10000", "10000", "11110", "10000", "10000", "10000", "11111"],
  A: ["00100", "01010", "10001", "10001", "11111", "10001", "10001", "10001", "10001"],
  D: ["11100", "10010", "10001", "10001", "10001", "10001", "10001", "10010", "11100"],
  Y: ["10001", "10001", "01010", "01010", "00100", "00100", "00100", "00100", "00100"],
});
const clamp = n => Math.max(0, Math.min(1, Number(n) || 0));

export class CabinetPanelState {
  constructor() {
    this.jobs = new Map();
    this.errors = new Set();
    this.revisions = new Map();
    this.epoch = 0;
    this.startedAt = 0;
    this.completed = false;
    this.completedAt = -Infinity;
  }
  receive(_source, type, detail = {}, elapsed = 0) {
    const { sessionId, gameId, state, revision } = detail;
    if (type === "game-updated") {
      if (!gameId || !revision || !Number.isFinite(elapsed) || this.revisions.get(gameId) === revision) return;
      this.revisions.set(gameId, revision);
      if (this.revisions.size > 128) this.revisions.delete(this.revisions.keys().next().value);
      if (sessionId) { this.jobs.delete(sessionId); this.errors.delete(sessionId); }
      this.completed = true;
      this.completedAt = elapsed;
      return;
    }
    // Voice/connection events and the hub's conversation are not game creation.
    if (type !== "workshop-status" || !sessionId || !gameId) return;
    if (WORK_STATES.has(state)) {
      if (!this.jobs.size) {
        this.epoch++;
        this.startedAt = elapsed;
        this.completed = false;
        this.errors.clear();
      }
      this.jobs.set(sessionId, { phase: state });
      this.errors.delete(sessionId);
    } else {
      const wasWorking = this.jobs.delete(sessionId);
      if (wasWorking) this.completed = false;
      if (state === "error") this.errors.add(sessionId);
      else this.errors.delete(sessionId);
      // A replayed "ready" status is not proof of a new successful publication.
    }
  }
  snapshot(elapsed) {
    const jobs = [...this.jobs.values()];
    const working = jobs.length > 0;
    const fault = this.errors.size > 0;
    const ready = !working && !fault && this.completed;
    const age = Math.max(0, elapsed - this.startedAt);
    const fill = working ? WAITING_FILL * clamp((age - READY_FALL_SECONDS) / (READY_FILL_SECONDS - READY_FALL_SECONDS)) : ready ? 1 : 0;
    const phase = working ? jobs[0].phase : ready ? "ready" : fault ? "error" : "idle";
    return { mode: working ? "working" : phase, phase, age, fill, working, ready, fault, epoch: this.epoch,
      celebrate: ready && elapsed - this.completedAt < READY_CONFIRM_SECONDS };
  }
}

// One pile for the WHOLE word: Y fills before D, then A, E and R. The five
// tubes are only the housing, not five separate sand simulations.
export function readyCells(letter, tube = 0) {
  return READY_GLYPHS[letter].flatMap((row, y) => [...row].flatMap((pixel, x) => pixel === "1" ? [{
    x, y, tube,
    columnY: tube * TUBE_STEP + LETTER_TOP + LETTER_HEIGHT * y / 8,
    threshold: .995 - .99 * (tube * TUBE_STEP + LETTER_HEIGHT * y / 8) / COLUMN_HEIGHT
      + (((x * 7 + tube * 3) % 5) - 2) * .001,
  }] : []));
}

export class ReadySand {
  constructor() { this.fill = 0; this.epoch = -1; }
  update(state, dt, reduced = false) {
    if (this.epoch !== state.epoch) { this.epoch = state.epoch; this.fill = 0; }
    const target = clamp(state.fill);
    // A fast finish if Codex completes before the minute is over.
    const step = Math.min(.1, Math.max(0, dt)) * (target > this.fill ? .85 : 1.6);
    this.fill = reduced ? target : this.fill + Math.sign(target - this.fill) * Math.min(Math.abs(target - this.fill), step);
    return this.fill;
  }
  light(cell, elapsed, working, reduced = false) {
    if (this.fill >= cell.threshold) return "settled";
    if (!working || reduced) return "off";
    let light = "off";
    for (const index of [cell.x, cell.x + 5]) {
      const grain = this.grain(index, elapsed);
      if (!grain.visible) continue;
      const distance = grain.y - cell.columnY;
      if (Math.abs(distance) < .009) return "grain";
      if (distance > 0 && distance < .026) light = "trail";
    }
    return light;
  }
  grain(index, elapsed) {
    const time = elapsed - index % 5 * .17 - Math.floor(index / 5) * 1.4;
    const flight = (time % 2.9) / READY_FALL_SECONDS;
    const y = -.025 + 1.06 * Math.pow(Math.max(0, flight), 1.45);
    const surface = LETTER_TOP + COLUMN_HEIGHT * (1 - this.fill);
    return { y, visible: time >= 0 && flight <= 1 && y >= 0 && y < surface };
  }
}
