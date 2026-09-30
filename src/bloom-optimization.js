// Same Gaussian weights/radii as UnrealBloomPass. Adjacent texels can be
// combined exactly with the texture unit's linear interpolation. Horizontal
// downsampling of later mips is deliberately left unchanged: those samples
// are two source texels apart, so pairing them would change the filter.
export function gaussianPairs(coefficients) {
  const pairs = [];
  for (let i = 1; i < coefficients.length; i += 2) {
    const next = coefficients[i + 1] ?? 0;
    const weight = coefficients[i] + next;
    pairs.push({ offset: weight ? i + next / weight : i, weight });
  }
  return pairs;
}

export function optimizeBloomPass(pass) {
  const targets = [pass.renderTargetBright, ...pass.renderTargetsHorizontal, ...pass.renderTargetsVertical];
  for (const target of targets) {
    target.dispose();
    target.depthBuffer = false; target.stencilBuffer = false;
  }
  for (const material of [pass.materialHighPassFilter, pass.compositeMaterial, ...pass.separableBlurMaterials]) {
    material.depthTest = false; material.depthWrite = false;
  }
  pass.separableBlurMaterials.forEach((material, mip) => {
    const coefficients = material.uniforms.gaussianCoefficients.value;
    const original = material.fragmentShader;
    const start = original.indexOf("void main() {");
    if (start < 0) throw new Error("Three bloom shader changed; inspect Gaussian pairing.");
    const sample = (offset, weight) => `diffuseSum += (texture2D(colorTexture, vUv + direction * invSize * ${offset.toPrecision(12)}) .rgb + texture2D(colorTexture, vUv - direction * invSize * ${offset.toPrecision(12)}) .rgb) * ${weight.toPrecision(12)};`;
    const paired = gaussianPairs(coefficients).map(({ offset, weight }) => sample(offset, weight)).join("\n");
    const unpaired = coefficients.slice(1).map((weight, i) => sample(i + 1, weight)).join("\n");
    material.fragmentShader = original.slice(0, start) + `void main() {
      vec3 diffuseSum = texture2D(colorTexture, vUv).rgb * ${coefficients[0].toPrecision(12)};
      ${mip === 0 ? paired : `if (direction.y > 0.5) { ${paired} } else { ${unpaired} }`}
      gl_FragColor = vec4(diffuseSum, 1.0);
    }`;
    material.needsUpdate = true;
  });
  return pass;
}
