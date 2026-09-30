import test from "node:test";
import assert from "node:assert/strict";
import { Texture } from "pixi.js";
import { initializePixiTextureUnits } from "../src/pixi-texture-units.js";

function renderer(maxBatchableTextures) {
  const bindings = [];
  const listeners = new Set();
  return {
    gl: {}, limits: { maxBatchableTextures }, bindings, listeners,
    texture: { bind: (texture, unit) => bindings.push([texture, unit]) },
    runners: { contextChange: {
      add: (listener) => listeners.add(listener),
      remove: (listener) => listeners.delete(listener),
    } },
  };
}

test("V3D batch samplers above unit 15 are initialized without capping capacity", () => {
  const r = renderer(24);
  const dispose = initializePixiTextureUnits(r);
  assert.deepEqual(r.bindings.map(([, unit]) => unit), [16,17,18,19,20,21,22,23]);
  assert.ok(r.bindings.every(([texture]) => texture === Texture.EMPTY));
  assert.equal(r.limits.maxBatchableTextures, 24);
  r.bindings.length = 0;
  for (const listener of r.listeners) listener.contextChange();
  assert.equal(r.bindings.length, 8, "context restoration initializes the extra units again");
  dispose();
  assert.equal(r.listeners.size, 0);
});

test("16-unit GPUs need no extra textures; non-WebGL renderers remain untouched", () => {
  const r = renderer(16);
  initializePixiTextureUnits(r)();
  assert.deepEqual(r.bindings, []);
  assert.doesNotThrow(() => initializePixiTextureUnits({})());
});
