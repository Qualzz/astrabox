import test from "node:test";
import assert from "node:assert/strict";
import { MeshBasicMaterial } from "three";
import { createShowcaseBlink } from "../src/showcase-blink.js";

test("prompt blink changes opacity without uploading its image or recompiling", () => {
  const material = new MeshBasicMaterial();
  const setBright = createShowcaseBlink(material);
  const shader = { uniforms: {}, fragmentShader: "void main() {\n#include <map_fragment>\n}" };
  material.onBeforeCompile(shader, {});
  const version = material.version;
  assert.equal(shader.uniforms.uPromptOpacity.value, 1);
  setBright(false);
  assert.equal(shader.uniforms.uPromptOpacity.value, .38 / .92);
  setBright(true);
  assert.equal(shader.uniforms.uPromptOpacity.value, 1);
  assert.equal(material.version, version);
  assert.match(shader.fragmentShader, /step\(0\.22, vMapUv\.y\)/);
  material.dispose();
});

test("showcases keep independent blink uniforms and preserve existing compile hooks", () => {
  const a = new MeshBasicMaterial(), b = new MeshBasicMaterial();
  let previousCalled = false;
  a.onBeforeCompile = () => { previousCalled = true; };
  const setA = createShowcaseBlink(a);
  createShowcaseBlink(b);
  const shaderA = { uniforms: {}, fragmentShader: "#include <map_fragment>" };
  const shaderB = { uniforms: {}, fragmentShader: "#include <map_fragment>" };
  a.onBeforeCompile(shaderA, {}); b.onBeforeCompile(shaderB, {});
  setA(false);
  assert.ok(previousCalled);
  assert.equal(shaderB.uniforms.uPromptOpacity.value, 1);
  assert.notEqual(shaderA.uniforms.uPromptOpacity, shaderB.uniforms.uPromptOpacity);
  a.dispose(); b.dispose();
});
