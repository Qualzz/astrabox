import { Color, MeshLambertMaterial, MeshPhongMaterial } from "three";

// Select by the actual GPU, not the OS/viewport: desktop quality is unchanged.
export function lunarRenderProfile(rendererName = "") {
  const v3d = /\bV3D\b/i.test(rendererName);
  return Object.freeze({
    name: v3d ? "v3d" : "full",
    simpleLighting: v3d,
    maxWidth: v3d ? 1280 : Infinity,
    maxHeight: v3d ? 720 : Infinity,
    shadowSize: v3d ? 1024 : 2048,
    bloomScale: v3d ? 0.5 : 1,
  });
}

export function lunarPixelRatio(profile, width, height, devicePixelRatio) {
  const native = Math.min(devicePixelRatio, width >= 1800 ? 1.25 : 1.5);
  return Math.min(native, profile.maxWidth / width, profile.maxHeight / height);
}

// The matte landscape doesn't need a physical metal/roughness BRDF. Phong
// retains highlights on the robot/platform. This is an explicit quality
// tradeoff (not pixel-identical PBR); geometry, lights, textures and shadows stay.
export function createLunarMaterialSimplifier() {
  const matte = new WeakMap(), glossy = new WeakMap();
  return function simplify(material, { highlights = false } = {}) {
    if (!material?.isMeshStandardMaterial) return material;
    const cache = highlights ? glossy : matte;
    if (cache.has(material)) return cache.get(material);
    const options = {};
    for (const key of [
      "name", "color", "map", "vertexColors", "flatShading", "emissive",
      "emissiveMap", "emissiveIntensity", "transparent", "opacity", "alphaTest",
      "alphaMap", "side", "shadowSide", "depthTest", "depthWrite", "fog",
      "normalMap", "normalMapType", "normalScale", "bumpMap", "bumpScale",
      "aoMap", "aoMapIntensity", "lightMap", "lightMapIntensity", "blending",
      "toneMapped", "polygonOffset", "polygonOffsetFactor", "polygonOffsetUnits",
    ]) options[key] = material[key];
    if (highlights) {
      options.shininess = Math.min(120, Math.max(2, 2 / Math.max(0.15, material.roughness) ** 4 - 2));
      options.specular = new Color(0.04, 0.04, 0.04).lerp(material.color, material.metalness * 0.6);
    }
    const result = highlights ? new MeshPhongMaterial(options) : new MeshLambertMaterial(options);
    // In particular, preserve Earth's animated, staged sunlight direction.
    result.onBeforeCompile = material.onBeforeCompile;
    const key = material.customProgramCacheKey();
    result.customProgramCacheKey = () => `${key}|lunar-simple-${highlights}`;
    cache.set(material, result);
    return result;
  };
}
