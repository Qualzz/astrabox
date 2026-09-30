// Keep at most one complete WebGL frame in flight. RAF callbacks are not GPU
// completion signals: submitting on every callback can build seconds of backlog
// on V3D. Poll without waiting; input/animation updates must stay outside this gate.
export function createGpuFrameGate(gl, { onError = console.error } = {}) {
  let pending = null;
  let lost = gl.isContextLost();
  let disposed = false;
  let error = null;

  const release = () => {
    if (pending && !gl.isContextLost()) gl.deleteSync(pending);
    pending = null;
  };
  const fail = (message) => {
    release();
    // Do not silently revert to an unbounded queue on a driver/context failure.
    error = message;
    onError(`GPU frame gate: ${message}`);
    return false;
  };
  const onLost = () => {
    lost = true;
    // Context loss has already invalidated and released its WebGL objects.
    pending = null;
  };
  const onRestored = () => {
    pending = null;
    lost = false;
    error = null;
  };
  gl.canvas.addEventListener("webglcontextlost", onLost);
  gl.canvas.addEventListener("webglcontextrestored", onRestored);

  return {
    ready() {
      if (disposed || lost || error || gl.isContextLost()) return false;
      if (!pending) return true;
      const status = gl.clientWaitSync(pending, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) return false;
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        release();
        return true;
      }
      if (gl.isContextLost()) { onLost(); return false; }
      return fail("GPU completion check failed; waiting for context restoration.");
    },
    submitted() {
      if (disposed || lost || error || gl.isContextLost()) return false;
      if (pending) throw new Error("A GPU frame is already in flight.");
      pending = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!pending) {
        if (gl.isContextLost()) { onLost(); return false; }
        return fail("Could not create a GPU completion fence.");
      }
      gl.flush();
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      release();
      gl.canvas.removeEventListener("webglcontextlost", onLost);
      gl.canvas.removeEventListener("webglcontextrestored", onRestored);
    },
    get pending() { return pending !== null; },
    get error() { return error; },
  };
}
