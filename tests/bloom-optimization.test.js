import test from "node:test";
import assert from "node:assert/strict";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { gaussianPairs, optimizeBloomPass } from "../src/bloom-optimization.js";

test("paired Gaussian samples preserve weights and first moments, including the odd tail", () => {
  for (const weights of [[.4,.3,.2,.1], [.4,.3,.2], [.4,.3], [.4,0,0]]) {
    const pairs = gaussianPairs(weights);
    const sum = weights.slice(1).reduce((a,b) => a+b, 0);
    const moment = weights.reduce((a,b,i) => a+b*i, 0);
    assert.ok(Math.abs(pairs.reduce((a,b) => a+b.weight, 0) - sum) < 1e-12);
    assert.ok(Math.abs(pairs.reduce((a,b) => a+b.weight*b.offset, 0) - moment) < 1e-12);
  }
});

test("bloom keeps the original five mip resolutions/radii and disables useless depth", () => {
  const pass = new UnrealBloomPass();
  const kernels = pass.separableBlurMaterials.map((m) => m.defines.KERNEL_RADIUS);
  optimizeBloomPass(pass); pass.setSize(1920, 931);
  assert.deepEqual(pass.separableBlurMaterials.map((m) => m.defines.KERNEL_RADIUS), kernels);
  assert.equal(pass.nMips, 5);
  assert.equal(pass.renderTargetsHorizontal[0].width, 960);
  assert.equal(pass.renderTargetsHorizontal[0].depthBuffer, false);
  assert.match(pass.separableBlurMaterials[1].fragmentShader, /if \(direction.y > 0.5\)/);
  assert.equal(pass.separableBlurMaterials[0].depthTest, false);
  pass.dispose();
});
