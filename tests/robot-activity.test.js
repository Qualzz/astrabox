import test from "node:test";
import assert from "node:assert/strict";
import { RobotActivity } from "../src/robot-activity.js";

test("idle/ready/voice acknowledgements never fabricate successful creation", () => {
  const activity = new RobotActivity();
  for (const state of ["ready", "idle", "listening", "heard", "speaking"]) activity.observeStatus({ sessionId: "one", state });
  assert.equal(activity.working, false);
  assert.equal(activity.completedAt, null);
  assert.equal(activity.celebrating(2), false);
});
test("remote jobs remain visible while another job finishes or errors", () => {
  const activity = new RobotActivity();
  activity.observeStatus({ sessionId: "phone", state: "building" });
  activity.observeStatus({ sessionId: "voice", state: "thinking" });
  activity.observeStatus({ sessionId: "voice", state: "error" });
  assert.equal(activity.displayState("listening"), "building");
  activity.observeStatus({ sessionId: "phone", state: "ready" });
  assert.equal(activity.working, false);
  assert.equal(activity.displayState("building"), "idle");
});
test("real publication celebrates once for 4.5 wall-clock seconds, not on every ready event", () => {
  const activity = new RobotActivity();
  activity.observeStatus({ sessionId: "a", state: "applying" });
  const event = { gameId: "one", revision: "v1", sessionId: "a" };
  assert.equal(activity.published(event, 10), true);
  assert.equal(activity.working, false);
  assert.equal(activity.celebrating(10.1), true);
  assert.equal(activity.published(event, 14), false);
  activity.observeStatus({ sessionId: "a", state: "ready" });
  assert.equal(activity.completedAt, 10);
  assert.equal(activity.celebrating(14.5), false);
  assert.equal(activity.celebrating(90), false); // Returning from a long game.
  assert.equal(activity.celebrating(9), false);
});
test("working takes precedence over another job's success", () => {
  const activity = new RobotActivity();
  activity.observeStatus({ sessionId: "b", state: "testing" });
  activity.published({ gameId: "one", revision: "v2" }, 10);
  assert.equal(activity.celebrating(11), false);
  assert.equal(activity.displayState("ready"), "testing");
});
