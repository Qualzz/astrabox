import { Texture } from "pixi.js";

// Pixi 8.20.1 initializes only units 0–15, while its batch shader uses the
// hardware limit (24 on the Pi's V3D). Even unused sampler-array entries need
// a complete texture. Fill the remaining units without reducing batch capacity
// or changing any image, and repeat after a WebGL context restoration.
export function initializePixiTextureUnits(renderer) {
  if (!renderer.gl) return () => {};
  const listener = {
    contextChange() {
      for (let unit = 16; unit < renderer.limits.maxBatchableTextures; unit++) {
        renderer.texture.bind(Texture.EMPTY, unit);
      }
    },
  };
  listener.contextChange();
  renderer.runners.contextChange.add(listener);
  return () => renderer.runners.contextChange.remove(listener);
}
