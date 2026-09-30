import test from "node:test";
import assert from "node:assert/strict";
import { MeshStandardMaterial, MeshBasicMaterial, Texture, Color } from "three";
import { lunarRenderProfile, lunarPixelRatio, createLunarMaterialSimplifier } from "../src/lunar-render-profile.js";

test("lunar V3D profile caps internal buffers, preserving aspect ratio and desktop quality", () => {
  const pi = lunarRenderProfile("ANGLE (Broadcom, V3D 7.1.7.0, OpenGL ES 3.1 Mesa)");
  assert.equal(pi.name, "v3d");
  assert.equal(pi.shadowSize, 1024);
  assert.equal(pi.bloomScale, 0.5);
  assert.equal(lunarPixelRatio(pi, 1920, 1080, 1), 2 / 3);
  assert.equal(lunarPixelRatio(pi, 3840, 2160, 2), 1 / 3);
  assert.equal(lunarPixelRatio(pi, 800, 1200, 1), 0.6);
  assert.equal(lunarPixelRatio(pi, 1280, 720, 2), 1);
  for (const name of ["", "Apple M3", "Intel UHD", "llvmpipe"]) {
    const full = lunarRenderProfile(name);
    assert.equal(full.simpleLighting, false);
    assert.equal(full.shadowSize, 2048);
    assert.equal(lunarPixelRatio(full, 1920, 1080, 2), 1.25);
    assert.equal(lunarPixelRatio(full, 1280, 720, 2), 1.5);
  }
});

test("simple materials retain textures, flat faces, transparency and planet shader hooks", () => {
  const simplify = createLunarMaterialSimplifier();
  const map = new Texture();
  const original = new MeshStandardMaterial({ map, normalMap: map, color: 0x345678,
    emissive: 0x334455, emissiveIntensity: 1.7, vertexColors: true, flatShading: true,
    transparent: true, opacity: 0.6, depthWrite: false, fog: false });
  const direction = { value: [1, 2, 3] };
  original.onBeforeCompile = shader => { shader.uniforms.direction = direction; };
  original.customProgramCacheKey = () => "earth-sun-direction-v1";
  const matte = simplify(original), glossy = simplify(original, { highlights: true });
  assert.ok(matte.isMeshLambertMaterial);
  assert.ok(glossy.isMeshPhongMaterial);
  for (const result of [matte, glossy]) {
    assert.equal(result.map, map);
    assert.equal(result.normalMap, map);
    assert.deepEqual(result.color, original.color);
    assert.deepEqual(result.emissive, new Color(0x334455));
    assert.equal(result.emissiveIntensity, 1.7);
    assert.equal(result.vertexColors, true);
    assert.equal(result.flatShading, true);
    assert.equal(result.transparent, true);
    assert.equal(result.opacity, 0.6);
    assert.equal(result.depthWrite, false);
    assert.equal(result.fog, false);
    const shader = { uniforms: {} };
    result.onBeforeCompile(shader);
    assert.equal(shader.uniforms.direction, direction);
    assert.match(result.customProgramCacheKey(), /earth-sun-direction-v1/);
  }
  assert.equal(simplify(original), matte);
  assert.equal(simplify(original, { highlights: true }), glossy);
  assert.notEqual(matte, glossy);
  const screen = new MeshBasicMaterial();
  assert.equal(simplify(screen), screen);
  assert.equal(original.isMeshStandardMaterial, true);
  assert.equal(glossy.envMap, null);
  original.dispose(); matte.dispose(); glossy.dispose(); screen.dispose(); map.dispose();
});
