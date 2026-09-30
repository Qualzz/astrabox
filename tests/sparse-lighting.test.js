import test from "node:test";
import assert from "node:assert/strict";
import { ShaderChunk, MeshStandardMaterial } from "three";
import { sparsePhysicalLighting, skipZeroLightContributions } from "../src/sparse-lighting.js";

test("sparse lighting preserves Three's BRDF verbatim except an exact-zero early return", () => {
  const source = ShaderChunk.lights_physical_pars_fragment;
  const patched = sparsePhysicalLighting();
  const guard = "\n\tif ( all( equal( directLight.color, vec3( 0.0 ) ) ) ) return;";
  assert.equal(patched.replace(guard, ""), source);
  assert.throws(() => sparsePhysicalLighting("changed upstream"), /signature changed/);
});

test("material compile hook and program key are preserved and applied once", () => {
  const material = new MeshStandardMaterial(); let called = 0;
  material.onBeforeCompile = () => called++;
  skipZeroLightContributions(material); const key = material.customProgramCacheKey();
  skipZeroLightContributions(material); assert.equal(material.customProgramCacheKey(), key);
  const shader = { fragmentShader: "#include <lights_physical_pars_fragment>" };
  material.onBeforeCompile(shader, {});
  assert.equal(called, 1); assert.match(shader.fragmentShader, /all\( equal\( directLight.color/);
  material.dispose();
});
