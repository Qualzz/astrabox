import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

const threeCrtShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uTransition: { value: 0 },
  },
  vertexShader: `
    varying vec2 vTextureCoord;

    void main() {
      vTextureCoord = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec2 vTextureCoord;
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uTransition;

    vec4 sampleCrt() {
      vec2 centered = vTextureCoord * 2.0 - 1.0;
      float distanceFromCenter = dot(centered, centered);
      vec2 uv = centered * (1.0 + distanceFromCenter * 0.035) * 0.5 + 0.5;
      // Short signal disturbance, not a bright flash or a modern fade overlay.
      float band = step(0.86, sin(floor(uv.y * 36.0) * 12.9898 + floor(uTime * 24.0) * 7.23));
      uv.x += band * sin(uTime * 71.0) * uTransition * 0.009;

      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return vec4(0.01, 0.02, 0.02, 1.0);
      }

      float offset = 0.0014 + uTransition * 0.0018;
      float red = texture2D(tDiffuse, uv + vec2(offset, 0.0)).r;
      float green = texture2D(tDiffuse, uv).g;
      float blue = texture2D(tDiffuse, uv - vec2(offset, 0.0)).b;

      float scanline = 0.94 + 0.06 * sin(uv.y * 540.0 * 3.141592 + uTime * 3.0);
      float vignette = 1.0 - smoothstep(0.38, 1.15, distanceFromCenter) * 0.62;
      vec3 color = vec3(red, green, blue) * scanline * vignette * (1.0 - band * uTransition * 0.13);
      // Bloom may add to alpha; the picture itself remains opaque.
      return vec4(color, 1.0);
    }

    void main() {
      gl_FragColor = sampleCrt();
    }
  `,
};

export function createThreeCrtPass({ output = false } = {}) {
  const pass = new ShaderPass(threeCrtShader);
  if (output) {
    // Finish CRT, tone mapping and output color conversion in one draw. These
    // are Three's own output transforms (including exposure), not a new look.
    // Keeping the intermediate form also lets QA compare against OutputPass.
    pass.material.fragmentShader = pass.material.fragmentShader.replace(
      "gl_FragColor = sampleCrt();",
      `gl_FragColor = sampleCrt();
       #include <tonemapping_fragment>
       #include <colorspace_fragment>
       gl_FragColor.rgb *= gl_FragColor.a;`,
    );
  }
  return pass;
}

export function updateThreeCrtPass(pass, elapsedSeconds) {
  pass.uniforms.uTime.value = elapsedSeconds;
}
