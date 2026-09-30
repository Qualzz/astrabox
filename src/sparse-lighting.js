import { ShaderChunk } from "three";

// Three evaluates the full GGX BRDF even when a local lamp's attenuation has
// made its radiance exactly zero. Most of the moon is outside these lights.
// This skips only zero contributions; the lit pixels use Three's original
// equations, LUTs, normal mapping, shadows and clearcoat unchanged.
export function sparsePhysicalLighting(source = ShaderChunk.lights_physical_pars_fragment) {
  const signature = /void RE_Direct_Physical\([^]*?\) \{/;
  if (!signature.test(source)) throw new Error("Three physical lighting signature changed; review sparse-light guard.");
  return source.replace(signature, "$&\n\tif ( all( equal( directLight.color, vec3( 0.0 ) ) ) ) return;");
}

export function skipZeroLightContributions(material) {
  if (!material?.isMeshStandardMaterial || material.userData.arcadeSparseLights) return;
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_physical_pars_fragment>", sparsePhysicalLighting());
  };
  material.customProgramCacheKey = () => `${previousKey}|arcade-zero-light-v1`;
  material.userData.arcadeSparseLights = true;
  material.needsUpdate = true;
}
