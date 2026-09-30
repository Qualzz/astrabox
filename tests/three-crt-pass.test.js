import test from "node:test";
import assert from "node:assert/strict";
import { createThreeCrtPass, updateThreeCrtPass } from "../src/three-crt-pass.js";

test("CRT output fuses Three's tone/color transforms after the entire effect, including borders", () => {
  const intermediate = createThreeCrtPass();
  const output = createThreeCrtPass({ output: true });
  try {
    assert.doesNotMatch(intermediate.material.fragmentShader, /#include <tonemapping_fragment>/);
    assert.match(output.material.fragmentShader, /gl_FragColor = sampleCrt\(\);\s*#include <tonemapping_fragment>\s*#include <colorspace_fragment>/);
    assert.equal(output.material.toneMapped, true);
    assert.equal(output.material.fragmentShader.split("void main()")[0], intermediate.material.fragmentShader.split("void main()")[0]);
  } finally {
    intermediate.dispose();
    output.dispose();
  }
});

test("CRT instances retain independent animation uniforms", () => {
  const a = createThreeCrtPass({ output: true });
  const b = createThreeCrtPass();
  try {
    updateThreeCrtPass(a, 12.5);
    assert.equal(a.uniforms.uTime.value, 12.5);
    assert.equal(b.uniforms.uTime.value, 0);
    assert.equal(a.uniforms, a.material.uniforms);
  } finally {
    a.dispose();
    b.dispose();
  }
});
