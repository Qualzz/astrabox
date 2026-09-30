export const ROBOT_WORK_STATES = new Set(["thinking", "building", "testing", "applying", "working"]);
export const ROBOT_SUCCESS_SECONDS = 4.5;

// Remote text jobs and local voice jobs share the robot, but opening the mic or
// replaying an old "ready" status must never invent a successful publication.
export class RobotActivity {
  constructor() {
    this.jobs = new Map();
    this.revisions = new Map();
    this.completedAt = null;
  }
  observeStatus({ sessionId, state } = {}) {
    if (!sessionId) return;
    if (ROBOT_WORK_STATES.has(state)) this.jobs.set(sessionId, state);
    else this.jobs.delete(sessionId);
  }
  published({ gameId, revision, sessionId } = {}, elapsed) {
    if (!gameId || !revision || !Number.isFinite(elapsed) || this.revisions.get(gameId) === revision) return false;
    this.revisions.set(gameId, revision);
    if (this.revisions.size > 128) this.revisions.delete(this.revisions.keys().next().value);
    if (sessionId) this.jobs.delete(sessionId);
    this.completedAt = elapsed;
    return true;
  }
  get workState() { return [...this.jobs.values()].at(-1) ?? null; }
  get working() { return this.jobs.size > 0; }
  celebrating(elapsed) {
    return !this.working && this.completedAt !== null && elapsed >= this.completedAt
      && elapsed - this.completedAt < ROBOT_SUCCESS_SECONDS;
  }
  displayState(fallback = "idle") {
    return this.workState ?? (ROBOT_WORK_STATES.has(fallback) ? "idle" : fallback);
  }
}
