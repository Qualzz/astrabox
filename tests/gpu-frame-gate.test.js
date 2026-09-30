import test from "node:test";
import assert from "node:assert/strict";
import { createGpuFrameGate } from "../src/gpu-frame-gate.js";

function fixture() {
  const calls = [], errors = [];
  let lost = false, status = 1, serial = 0;
  const gl = {
    canvas: new EventTarget(),
    SYNC_GPU_COMMANDS_COMPLETE: 0,
    TIMEOUT_EXPIRED: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, WAIT_FAILED: 4,
    isContextLost: () => lost,
    fenceSync: (...args) => { calls.push(["fence", ...args]); return { id: ++serial }; },
    clientWaitSync: (...args) => { calls.push(["wait", ...args]); return status; },
    deleteSync: sync => calls.push(["delete", sync]),
    flush: () => calls.push(["flush"]),
  };
  const gate = createGpuFrameGate(gl, { onError: message => errors.push(message) });
  return { gl, gate, calls, errors, status: value => { status = value; },
    lose: () => { lost = true; gl.canvas.dispatchEvent(new Event("webglcontextlost")); },
    restore: () => { lost = false; gl.canvas.dispatchEvent(new Event("webglcontextrestored")); },
  };
}

test("GPU gate polls with zero timeout and never queues a second unfinished image", () => {
  const { gl, gate, calls } = fixture();
  assert.equal(gate.ready(), true);
  assert.equal(gate.submitted(), true);
  for (let i = 0; i < 120; i++) assert.equal(gate.ready(), false);
  assert.equal(gate.pending, true);
  assert.throws(() => gate.submitted(), /already in flight/);
  assert.deepEqual(calls.filter(c => c[0] === "fence"), [["fence", gl.SYNC_GPU_COMMANDS_COMPLETE, 0]]);
  assert.equal(calls.filter(c => c[0] === "flush").length, 1);
  assert.ok(calls.filter(c => c[0] === "wait").every(c => c[2] === 0 && c[3] === 0));
  gate.dispose();
});

for (const name of ["ALREADY_SIGNALED", "CONDITION_SATISFIED"]) {
  test(`GPU gate releases ${name} once and accepts a fresh image`, () => {
    const f = fixture();
    f.gate.submitted();
    f.status(f.gl[name]);
    assert.equal(f.gate.ready(), true);
    assert.equal(f.gate.ready(), true);
    assert.equal(f.gate.pending, false);
    assert.equal(f.calls.filter(c => c[0] === "delete").length, 1);
    assert.equal(f.gate.submitted(), true);
    f.gate.dispose();
    assert.equal(f.calls.filter(c => c[0] === "delete").length, 2);
  });
}

test("GPU gate invalidates old fences on context loss and resumes on restoration", () => {
  const f = fixture();
  f.gate.submitted();
  f.lose();
  assert.equal(f.gate.pending, false);
  assert.equal(f.gate.ready(), false);
  assert.equal(f.gate.submitted(), false);
  f.restore();
  assert.equal(f.gate.ready(), true);
  f.gate.submitted();
  assert.equal(f.calls.filter(c => c[0] === "delete").length, 0);
  f.gate.dispose();
});

test("GPU gate reports a failed wait once instead of silently flooding the GPU", () => {
  const f = fixture();
  f.gate.submitted();
  f.status(f.gl.WAIT_FAILED);
  assert.equal(f.gate.ready(), false);
  assert.equal(f.gate.ready(), false);
  assert.equal(f.gate.submitted(), false);
  assert.equal(f.errors.length, 1);
  assert.match(f.gate.error, /completion check failed/);
  f.lose(); f.restore();
  assert.equal(f.gate.error, null);
  assert.equal(f.gate.ready(), true);
  f.gate.dispose();
});

test("GPU gate handles a failed fence allocation without flushing more work", () => {
  const f = fixture();
  f.gl.fenceSync = () => null;
  assert.equal(f.gate.submitted(), false);
  assert.equal(f.gate.ready(), false);
  assert.equal(f.gate.pending, false);
  assert.equal(f.errors.length, 1);
  assert.equal(f.calls.filter(c => c[0] === "flush").length, 0);
  f.gate.dispose();
});

test("GPU gate disposal releases resources once and cannot be revived by events", () => {
  const f = fixture();
  f.gate.submitted();
  f.gate.dispose(); f.gate.dispose();
  f.lose(); f.restore();
  assert.equal(f.gate.ready(), false);
  assert.equal(f.gate.submitted(), false);
  assert.equal(f.calls.filter(c => c[0] === "delete").length, 1);
});
