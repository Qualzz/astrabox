import {
  CanvasTexture, Color, DataTexture, ImageLoader, LinearFilter, RGBAFormat, ShaderMaterial,
  SRGBColorSpace, Vector2,
} from "three";
import { ASTRA_PHOSPHOR, drawRobotVoiceDisplay, getRobotVoicePresentation } from "./robot-voice-display.js";

const WORKING_STATES = new Set(["thinking", "working", "building", "testing", "applying"]);
const CONNECTION_STATES = new Set(["connecting", "reconnecting", "error", "disconnected"]);
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || 0));
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const smooth = (value) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
const approach = (from, to, rate, delta) => from + (to - from) * (1 - Math.exp(-rate * delta));
const pulse = (phase, start, duration) => phase < start || phase > start + duration
  ? 0 : Math.sin((phase - start) / duration * Math.PI) ** 2;

// These are presentation decisions, not progress estimates. In particular,
// "ready" never means a successful publication: that needs completedAt from
// the real publication event, in the same monotonic seconds as elapsed.
export function getRobotFaceTarget({
  elapsed = 0, state = "idle", focused = false, voiceActive = false,
  activity = {}, diagnostic = null, message = "", pose = null,
  completedAt = null, reducedMotion = false,
} = {}) {
  const time = finite(elapsed);
  const working = WORKING_STATES.has(state);
  const presentation = getRobotVoicePresentation({ activity, state, voiceActive, diagnostic, message });
  const needsVoice = presentation.input || presentation.output || Boolean(diagnostic)
    || CONNECTION_STATES.has(state) || activity.microphone === "permission"
    || (presentation.live && ["muted", "ended"].includes(activity.microphone))
    || (presentation.live && !working);
  const age = Number.isFinite(completedAt) ? time - completedAt : Infinity;
  const celebrating = !working && age >= 0 && age < 4.5;
  const face = pose?.face || {};
  const phase = ((time % 17) + 17) % 17;
  const blink = reducedMotion ? 0 : typeof face.blink === "boolean" ? Number(face.blink)
    : Number.isFinite(face.blink) ? clamp(face.blink, 0, 1)
      : Math.max(pulse(phase, 3.4, .23), pulse(phase, 11.9, .28), pulse(phase, 12.34, .19));
  // A small manufacturer signature once in a long while, not the robot's face.
  const logoPhase = ((time % 52) + 52) % 52;
  const logo = !focused && !working && !needsVoice && !celebrating && !reducedMotion
    && logoPhase > 46 && logoPhase < 47.35;
  const joy = celebrating ? 1 - smooth((age - 3.1) / 1.4) : 0;
  return {
    mode: needsVoice ? "voice" : working ? "working" : celebrating ? "celebrating" : logo ? "logo" : "eyes",
    working, celebrating, presentation,
    loading: Number(working), voice: Number(needsVoice), logo: Number(logo), joy,
    blink,
    look: reducedMotion ? 0 : clamp(finite(face.look, focused ? 0 : Math.sin(time * .37) * .045), -.12, .12),
    lookY: reducedMotion ? 0 : clamp(finite(face.lookY, focused ? .014 : Math.sin(time * .23 + 1) * .014), -.08, .08),
    curiosity: reducedMotion ? 0 : clamp(finite(face.curiosity, (Math.sin(time * .21) * .5 + .5) ** 8 * .5), 0, 1),
    smile: Math.max(joy, reducedMotion ? 0 : clamp(face.smile, 0, 1)),
  };
}

// All transitions start from the currently displayed pose. Interrupting a
// loader with speech, or ending it halfway through its entrance, never swaps
// textures or resets a transition to a different face.
export function createRobotFaceController({ reducedMotion = false } = {}) {
  let previousTime = null;
  let current = { loading: 0, voice: 0, logo: 0, joy: 0, look: 0, lookY: 0, curiosity: 0, smile: 0, blink: 0 };
  let status = { ...current, mode: "eyes", working: false, celebrating: false, presentation: null };
  return {
    update(options = {}) {
      const elapsed = finite(options.elapsed);
      const delta = clamp(finite(options.delta, previousTime === null ? 1 / 60 : elapsed - previousTime), 0, .1);
      previousTime = elapsed;
      const target = getRobotFaceTarget({ ...options, elapsed, reducedMotion });
      for (const key of ["loading", "voice", "logo", "joy", "look", "lookY", "curiosity", "smile"]) {
        const rate = key === "loading" ? 5.5 : key === "logo" ? 7 : key === "voice" ? 10 : 9;
        current[key] = approach(current[key], target[key], reducedMotion ? 16 : rate, delta);
      }
      // The eyelid pose already has a soft close/open envelope. Filtering a
      // 150 ms blink again would make it disappear at a 30 Hz render rate.
      current.blink = target.blink;
      status = { ...target, ...current, elapsed, reducedMotion };
      return status;
    },
    get status() { return status; },
  };
}

export const ROBOT_FACE_FRAGMENT_SHADER = /* glsl */`
  varying vec2 vFaceUv;
  uniform float uTime;
  uniform float uAspect;
  uniform float uLoading;
  uniform float uVoice;
  uniform float uLogo;
  uniform float uLogoReady;
  uniform float uBlink;
  uniform float uJoy;
  uniform float uCuriosity;
  uniform float uSmile;
  uniform vec2 uLook;
  uniform vec3 uPhosphor;
  uniform sampler2D uVoiceTexture;
  uniform sampler2D uLogoTexture;

  float roundedBox(vec2 p, vec2 halfSize, float radius) {
    vec2 q = abs(p) - halfSize + radius;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - radius;
  }
  float ink(float distance) {
    float aa = max(fwidth(distance), .0012);
    return 1.0 - smoothstep(-aa, aa, distance);
  }
  float phosphor(float distance) {
    return .86 * ink(distance) + .105 * exp(-max(distance, 0.0) * 105.0);
  }
  void main() {
    // This GLTF's TV has v=0 at the top; textures therefore use flipY=false.
    vec2 p = vec2((vFaceUv.x - .5) * uAspect, .5 - vFaceUv.y);
    float morph = uLoading * uLoading * (3.0 - 2.0 * uLoading);
    float angle = uTime * 2.1;
    vec2 orbit = vec2(cos(angle), sin(angle)) * .155;
    float faceLight = 0.0;
    for (int i = 0; i < 2; i++) {
      float side = float(i) * 2.0 - 1.0;
      vec2 eyeCenter = vec2(side * .169, .025) + uLook;
      eyeCenter.y += side * .012 * uCuriosity;
      // The very same eye shapes narrow into two lights, then orbit. No
      // crossfade to an unrelated spinner and no invented completion percent.
      vec2 center = mix(eyeCenter, orbit * side, morph);
      vec2 eyeSize = vec2(.061, (.108 + side * .012 * uCuriosity) * (1.0 - uBlink) + .004);
      vec2 size = mix(eyeSize, vec2(.024), morph);
      float happiness = smoothstep(.15, .85, uSmile) * (1.0 - morph) * (1.0 - uBlink);
      size.y = mix(size.y, .009, happiness);
      float radius = min(.026, min(size.x, size.y));
      vec2 local = p - center;
      // Bend a rounded capsule into a happy arch. Interpolating the distance
      // fields of a full eye and an arch produced pointed, hexagonal eyes
      // at small smile values; deforming one shape retains its round ends.
      vec2 eyelid = local;
      eyelid.y -= happiness * (.036 - local.x * local.x * 11.0);
      float eye = roundedBox(eyelid, size, radius);
      faceLight += phosphor(eye);
      vec2 brow = local - vec2(0.0, .169 + .015 * side * uCuriosity);
      brow.y -= brow.x * side * .16 * uCuriosity;
      float eyebrow = roundedBox(brow, vec2(.043, .004), .003);
      faceLight += phosphor(eyebrow) * uCuriosity * (1.0 - morph) * .58;
    }
    // A delicate orbit appears only once the eyes have started converging.
    float track = abs(length(p) - .155) - .0016;
    float trail = .5 + .5 * cos(atan(p.y, p.x) - angle);
    faceLight += phosphor(track) * morph * (.075 + trail * trail * .13);
    vec2 mouthPoint = p - vec2(uLook.x * .35, -.151);
    float mouth = max(abs(mouthPoint.y - (mouthPoint.x * mouthPoint.x * 3.0 - .012)) - .004, abs(mouthPoint.x) - .048);
    faceLight += phosphor(mouth) * uJoy * (1.0 - morph) * .65;

    vec2 logoUv = p / .36 + .5;
    logoUv.y = 1.0 - logoUv.y;
    float logoBounds = step(0.0, logoUv.x) * step(logoUv.x, 1.0) * step(0.0, logoUv.y) * step(logoUv.y, 1.0);
    float logoMask = texture2D(uLogoTexture, clamp(logoUv, 0.0, 1.0)).a * logoBounds;
    float logoBlend = uLogo * uLogoReady;
    float illumination = mix(faceLight, logoMask * .91, logoBlend);
    vec3 color = vec3(.0006, .0011, .0007) + uPhosphor * illumination;
    // The only bitmap animation is live audio. Idle eyes, blink and loader
    // change uniforms, never a canvas upload or an extra postprocess pass.
    vec3 voiceColor = texture2D(uVoiceTexture, vFaceUv).rgb;
    color = mix(color, voiceColor, uVoice);
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

export function createRobotLogoTexture(image, createCanvas = () => document.createElement("canvas")) {
  // openai.svg has a viewBox but no explicit dimensions. Chromium reports a
  // decoded 150x150 image, yet its direct SVG texSubImage2D upload fails in
  // cabinet QA. Rasterize once before allocating fixed-size GPU storage.
  // Never resize this canvas or mark the resulting texture dirty per frame.
  const canvas = createCanvas();
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.clearRect(0, 0, 256, 256);
  context.drawImage(image, 0, 0, 256, 256);
  const texture = new CanvasTexture(canvas);
  texture.flipY = false;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

export function createRobotFaceDisplay({
  aspect = 1.24, reducedMotion = false, logoUrl = "/assets/logos/openai.svg",
} = {}) {
  const screenAspect = clamp(aspect, .75, 2);
  const controller = createRobotFaceController({ reducedMotion });
  const emptyTexture = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, RGBAFormat);
  emptyTexture.needsUpdate = true;
  emptyTexture.flipY = false;
  const uniforms = {
    uTime: { value: 0 }, uAspect: { value: screenAspect }, uLoading: { value: 0 },
    uVoice: { value: 0 }, uLogo: { value: 0 }, uLogoReady: { value: 0 },
    uBlink: { value: 0 }, uJoy: { value: 0 }, uCuriosity: { value: 0 }, uSmile: { value: 0 },
    uLook: { value: new Vector2() }, uPhosphor: { value: new Color(ASTRA_PHOSPHOR) },
    uVoiceTexture: { value: emptyTexture }, uLogoTexture: { value: emptyTexture },
  };
  const material = new ShaderMaterial({
    name: "robot-phosphor-face", uniforms, toneMapped: false,
    vertexShader: /* glsl */`
      varying vec2 vFaceUv;
      void main() {
        vFaceUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: ROBOT_FACE_FRAGMENT_SHADER,
  });
  let disposed = false;
  let logoTexture = null;
  let voiceTexture = null;
  let voiceCanvas = null;
  let voiceContext = null;
  let voiceKey = "";
  let lastVoiceUpload = -Infinity;
  let voiceUploads = 0;
  let lastStatus = controller.status;

  if (logoUrl && typeof document !== "undefined") {
    new ImageLoader().load(logoUrl, (image) => {
      if (disposed) return;
      logoTexture = createRobotLogoTexture(image);
      if (logoTexture) {
        uniforms.uLogoTexture.value = logoTexture;
        uniforms.uLogoReady.value = 1;
      }
    });
  }

  const ensureVoiceSurface = (width) => {
    if (voiceCanvas?.width === width) return true;
    if (typeof document === "undefined") return false;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round(width / screenAspect);
    const context = canvas.getContext("2d");
    if (!context) return false;
    voiceTexture?.dispose();
    voiceCanvas = canvas;
    voiceContext = context;
    voiceTexture = new CanvasTexture(canvas);
    voiceTexture.flipY = false;
    voiceTexture.colorSpace = SRGBColorSpace;
    voiceTexture.generateMipmaps = false;
    voiceTexture.minFilter = LinearFilter;
    voiceTexture.magFilter = LinearFilter;
    uniforms.uVoiceTexture.value = voiceTexture;
    voiceKey = "";
    return true;
  };

  return {
    material,
    update(options = {}) {
      if (disposed) return lastStatus;
      const status = controller.update(options);
      const elapsed = finite(options.elapsed);
      uniforms.uTime.value = reducedMotion ? 0 : elapsed % (Math.PI * 2 / 2.1 * 1000);
      uniforms.uLoading.value = status.loading;
      uniforms.uLogo.value = status.logo;
      uniforms.uBlink.value = status.blink;
      uniforms.uJoy.value = status.joy;
      uniforms.uCuriosity.value = status.curiosity;
      uniforms.uSmile.value = status.smile;
      uniforms.uLook.value.set(status.look, status.lookY);
      if (status.mode === "voice") {
        const { presentation } = status;
        const width = options.focused ? 512 : 256;
        const key = [presentation.mode, presentation.label, presentation.hint, presentation.footer, width].join("|");
        const active = presentation.input || presentation.output;
        if ((voiceKey !== key || (active && elapsed - lastVoiceUpload >= 1 / 15)) && ensureVoiceSurface(width)) {
          // drawRobotVoiceDisplay uses a 1024-wide design grid. Draw at that
          // scale into a modest texture, retaining its readable proportions.
          voiceContext.setTransform(width / 1024, 0, 0, width / 1024, 0, 0);
          drawRobotVoiceDisplay(voiceContext, {
            ...options, width: 1024, height: 1024 / screenAspect, elapsed, reducedMotion,
          });
          voiceTexture.needsUpdate = true;
          voiceKey = key;
          lastVoiceUpload = elapsed;
          voiceUploads += 1;
        }
      }
      // Don't fade to an empty surface if Canvas is unavailable.
      uniforms.uVoice.value = voiceTexture ? status.voice : 0;
      lastStatus = { ...status, voiceUploads, voiceWidth: voiceCanvas?.width || 0, logoReady: Boolean(uniforms.uLogoReady.value) };
      return lastStatus;
    },
    get status() { return lastStatus; },
    dispose() {
      if (disposed) return;
      disposed = true;
      material.dispose();
      emptyTexture.dispose();
      logoTexture?.dispose();
      voiceTexture?.dispose();
    },
  };
}
