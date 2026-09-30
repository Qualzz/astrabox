import { Filter, GlProgram } from "pixi.js";

const vertex = `
  in vec2 aPosition;
  out vec2 vTextureCoord;
  uniform highp vec4 uInputSize;
  uniform highp vec4 uOutputFrame;
  uniform vec4 uOutputTexture;

  vec4 filterVertexPosition(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
  }

  vec2 filterTextureCoord(void) {
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
  }

  void main(void) {
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
  }
`;

const fragment = `
  in vec2 vTextureCoord;
  uniform sampler2D uTexture;
  uniform float uTime;
  uniform highp vec4 uInputSize;
  uniform highp vec4 uOutputFrame;

  vec4 samplePictureCrt() {
    // Filter textures can be pooled larger than the actual screen. Geometry
    // uses normalized screen UV, then maps back into the used texture region.
    vec2 sourceScale = uOutputFrame.zw * uInputSize.zw;
    vec2 centered = (vTextureCoord / sourceScale) * 2.0 - 1.0;
    float distanceFromCenter = dot(centered, centered);
    vec2 uv = centered * (1.0 + distanceFromCenter * 0.035) * 0.5 + 0.5;

    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      return vec4(0.01, 0.02, 0.02, 1.0);
    }

    float offset = 0.0014;
    float red = texture2D(uTexture, (uv + vec2(offset, 0.0)) * sourceScale).r;
    float green = texture2D(uTexture, uv * sourceScale).g;
    float blue = texture2D(uTexture, (uv - vec2(offset, 0.0)) * sourceScale).b;
    float alpha = texture2D(uTexture, uv * sourceScale).a;

    float scanline = 0.94 + 0.06 * sin(uv.y * 540.0 * 3.141592 + uTime * 3.0);
    float vignette = 1.0 - smoothstep(0.38, 1.15, distanceFromCenter) * 0.62;
    vec3 color = vec3(red, green, blue) * scanline * vignette;
    return vec4(color, alpha);
  }

  void main(void) {
    gl_FragColor = samplePictureCrt();
  }
`;

export function createCrtFilter() {
  return new Filter({
    glProgram: new GlProgram({ vertex, fragment }),
    resources: {
      crtUniforms: {
        uTime: { value: 0, type: "f32" },
      },
    },
  });
}

export function updateCrtFilter(filter, deltaSeconds) {
  filter.resources.crtUniforms.uniforms.uTime += deltaSeconds;
}
