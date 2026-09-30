// The play prompt is the only content in the bottom 22% of the showcase texture.
// Keep the preview/title texture resident: blinking changes one uniform, not a
// 1300 × 1200 canvas upload and mipmap rebuild twice every 1.3 seconds.
export function createShowcaseBlink(material) {
  const opacity = { value: 1 };
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    shader.uniforms.uPromptOpacity = opacity;
    shader.fragmentShader = "uniform float uPromptOpacity;\n" + shader.fragmentShader.replace(
      "#include <map_fragment>",
      "#include <map_fragment>\ndiffuseColor.a *= mix(uPromptOpacity, 1.0, step(0.22, vMapUv.y));",
    );
  };
  material.customProgramCacheKey = () => `${previousKey}|showcase-prompt-blink-v1`;
  material.needsUpdate = true;
  return (bright) => { opacity.value = bright ? 1 : 0.38 / 0.92; };
}
