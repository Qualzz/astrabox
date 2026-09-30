import {
  Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping,
  RGBAFormat, ShaderMaterial, UnsignedByteType,
} from "three";

// Enamel/plastic inspired by the cream LLM INC cabinet, not its printed bezel
// bitmap pasted onto the robot. Colour inputs are sRGB; Three converts them to
// linear values before lighting or status-strip blending.
export const ROBOT_FINISH_PALETTE = Object.freeze({
  enamel: "#d6c7a6", cover: "#e5d8ba", seam: "#66492e",
  gasket: "#30251b", tire: "#493626", hub: "#cfb080",
  brass: "#8e7048", idle: "#b38942", blue: "#4654df",
  violet: "#aa72ed", ready: "#72dc8d",
});
export const ROBOT_SUCCESS_SECONDS = 4.5;

const clamp01 = value => Math.max(0, Math.min(1, value));
const smooth = value => { const t = clamp01(value); return t * t * (3 - 2 * t); };

// A completion is an event, not the workshop's persistent "ready" state. The
// caller supplies its timestamp using the same seconds clock as elapsed.
export function robotStatusLight({ elapsed = 0, working = false, completedAt = null, reducedMotion = false } = {}) {
  const time = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const age = Number.isFinite(completedAt) ? time - completedAt : Infinity;
  const ready = !working && age >= 0 && age < ROBOT_SUCCESS_SECONDS
    ? 1 - smooth((age - (ROBOT_SUCCESS_SECONDS - .65)) / .65) : 0;
  return {
    working: working ? 1 : 0, ready,
    phase: reducedMotion ? 0 : time,
    mode: working ? "working" : ready > 0 ? "ready" : "idle",
  };
}

// A single small, static, mipmapped grain texture for the whole robot. Grain
// fades naturally in the mip chain rather than flickering as the robot moves.
function createEnamelGrain() {
  const size = 64, pixels = new Uint8Array(size * size * 4);
  let seed = 0x4c4c4d;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      pixels[i] = Math.round(255 * (.3 + random() * .4));
      // Periodic low-frequency variation: no visible seam at repeat boundaries.
      pixels[i + 1] = Math.round(128 + 40 * Math.sin(x / size * Math.PI * 2)
        * Math.cos(y / size * Math.PI * 4) + 18 * Math.sin((x + y) / size * Math.PI * 6));
      pixels[i + 2] = pixels[i]; pixels[i + 3] = 255;
    }
  }
  const texture = new DataTexture(pixels, size, size, RGBAFormat, UnsignedByteType);
  texture.name = "LLM INC static enamel grain";
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter; texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

const FINISH_VERTEX = /* glsl */`
varying vec3 vRobotFinishPosition;
varying vec3 vRobotFinishNormal;
`;
const FINISH_FRAGMENT = /* glsl */`
uniform sampler2D uRobotGrain;
varying vec3 vRobotFinishPosition;
varying vec3 vRobotFinishNormal;
vec2 robotGrain() {
  vec3 weights = abs(normalize(vRobotFinishNormal));
  weights /= max(dot(weights, vec3(1.0)), 0.001);
  vec3 p = vRobotFinishPosition * 2.0;
  return texture2D(uRobotGrain, p.yz).rg * weights.x
    + texture2D(uRobotGrain, p.xz).rg * weights.y
    + texture2D(uRobotGrain, p.xy).rg * weights.z;
}
`;

function decorateMaterial(material, kind, grain) {
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    shader.uniforms.uRobotGrain = { value: grain };
    shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>\n${FINISH_VERTEX}`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vRobotFinishPosition = position;
        vRobotFinishNormal = normal;`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>\n${FINISH_FRAGMENT}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec2 finishGrain = robotGrain() - vec2(0.5);
        diffuseColor.rgb *= 1.0 + finishGrain.x * 0.12 + finishGrain.y * 0.10;
        ${kind === "tire" ? /* glsl */`
          // These bands live in wheel-local coordinates and therefore rotate
          // with the real axle. No animated UVs and no additional geometry.
          float wheelAngle = atan(vRobotFinishPosition.z, vRobotFinishPosition.y);
          float radialBands = sin(wheelAngle * 18.0);
          float bandAA = max(fwidth(radialBands), 0.08);
          float tread = smoothstep(0.70 - bandAA, 0.70 + bandAA, radialBands);
          diffuseColor.rgb *= 1.0 - tread * 0.30;
        ` : kind === "hub" ? /* glsl */`
          float wheelAngle = atan(vRobotFinishPosition.z, vRobotFinishPosition.y);
          float rimRadius = length(vRobotFinishPosition.yz);
          float markAA = max(fwidth(wheelAngle), 0.025);
          float spoke = 1.0 - smoothstep(0.10, 0.10 + markAA, abs(sin(wheelAngle * 3.0)));
          float ring = smoothstep(0.061, 0.065, rimRadius) * (1.0 - smoothstep(0.092, 0.096, rimRadius));
          diffuseColor.rgb *= 1.0 - spoke * ring * 0.48;
        ` : ""}`);
  };
  material.customProgramCacheKey = () => `${previousKey}|llm-vintage-${kind}-v1`;
  material.userData.robotFinish = kind;
  material.needsUpdate = true;
}

function classifyPart(name) {
  if (/^lamp-lens-(front|rear)$/.test(name)) return "lamp";
  if (/^tire-/.test(name)) return "tire";
  if (/^hub-/.test(name)) return "hub";
  if (name === "display-gasket") return "gasket";
  if (name.includes("seam")) return "seam";
  if (/^(axle-|lamp-bezel-)/.test(name) || name === "neck-bearing") return "brass";
  if (name === "chassis-top-cover") return "cover";
  if (["chassis-shell", "head-shell", "neck-spindle"].includes(name)) return "enamel";
  return null;
}

function createStatusStrip(uniforms) {
  return new ShaderMaterial({
    name: "LLM INC Ultra status strip", uniforms, toneMapped: false,
    vertexShader: /* glsl */`
      varying vec2 vLampPosition;
      void main() {
        vLampPosition = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uWorking;
      uniform float uReady;
      uniform vec3 uIdleColor;
      uniform vec3 uBlueColor;
      uniform vec3 uVioletColor;
      uniform vec3 uReadyColor;
      varying vec2 vLampPosition;
      void main() {
        float x = clamp(vLampPosition.x / 0.255 + 0.5, 0.0, 1.0);
        float ribbon = 0.5 + 0.5 * sin(x * 8.0 - uTime * 2.8);
        float shine = pow(0.5 + 0.5 * sin(x * 6.0 - uTime * 2.2), 5.0);
        vec3 workColor = mix(uBlueColor, uVioletColor, ribbon) * (0.76 + 0.24 * shine);
        vec3 color = mix(uIdleColor * 0.19, uReadyColor * 0.90, uReady);
        color = mix(color, workColor, uWorking);
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

// Run before the lunar material profile conversion. The grain/tread hooks are
// compatible with Standard and Phong; the two existing lens meshes share one
// tiny unlit shader. Updating this controller changes uniforms only.
export function applyRobotFinish(robot) {
  const grain = createEnamelGrain();
  const owned = new Set(), assignments = [], cache = new Map();
  const uniforms = {
    uTime: { value: 0 }, uWorking: { value: 0 }, uReady: { value: 0 },
    uIdleColor: { value: new Color(ROBOT_FINISH_PALETTE.idle) },
    uBlueColor: { value: new Color(ROBOT_FINISH_PALETTE.blue) },
    uVioletColor: { value: new Color(ROBOT_FINISH_PALETTE.violet) },
    uReadyColor: { value: new Color(ROBOT_FINISH_PALETTE.ready) },
  };
  const statusMaterial = createStatusStrip(uniforms);
  owned.add(statusMaterial);
  robot.traverse(object => {
    if (!object.isMesh) return;
    const kind = classifyPart(object.name);
    if (!kind) return;
    const original = object.material;
    const replace = source => {
      if (kind === "lamp") return statusMaterial;
      if (!source?.isMeshStandardMaterial) return source;
      const key = `${source.uuid}:${kind}`;
      if (cache.has(key)) return cache.get(key);
      const material = source.clone();
      // Material.clone deliberately doesn't copy shader callbacks in Three.
      material.onBeforeCompile = source.onBeforeCompile;
      const sourceKey = source.customProgramCacheKey();
      material.customProgramCacheKey = () => sourceKey;
      material.name = `LLM INC vintage ${kind}`;
      material.color.set(ROBOT_FINISH_PALETTE[kind]);
      material.roughness = kind === "tire" || kind === "gasket" ? .86 : kind === "brass" ? .58 : .49;
      material.metalness = kind === "brass" ? .34 : kind === "tire" || kind === "gasket" ? 0 : .025;
      if ("clearcoat" in material) material.clearcoat = kind === "enamel" || kind === "cover" ? .08 : 0;
      material.emissive.set(0x000000);
      decorateMaterial(material, kind, grain);
      cache.set(key, material); owned.add(material);
      return material;
    };
    object.material = Array.isArray(original) ? original.map(replace) : replace(original);
    assignments.push({ object, original, applied: object.material });
  });
  let disposed = false;
  let status = robotStatusLight();
  return {
    get status() { return status; },
    update({ delta = 1 / 60, ...state } = {}) {
      if (disposed) return status;
      status = robotStatusLight(state);
      const dt = Number.isFinite(delta) ? Math.max(0, delta) : 0;
      const blend = 1 - Math.exp(-dt * 8);
      uniforms.uTime.value = status.phase;
      uniforms.uWorking.value += (status.working - uniforms.uWorking.value) * blend;
      uniforms.uReady.value += (status.ready - uniforms.uReady.value) * blend;
      return status;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      // Only restore a mesh if its material hasn't since been replaced by the
      // Pi's lighting profile or another owner.
      for (const { object, original, applied } of assignments) {
        if (object.material === applied) object.material = original;
      }
      for (const material of owned) material.dispose();
      grain.dispose();
    },
  };
}
