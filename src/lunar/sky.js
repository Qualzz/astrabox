import * as THREE from "three";
import { PALETTE, SUN_POSITION, EARTH_POSITION } from "./constants.js";
import { lerp, mulberry32 } from "./noise.js";

export function createSkyDome() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: new THREE.Color(0x01030a) },
      uHorizon: { value: new THREE.Color(PALETTE.horizon) },
      uSunDirection: { value: SUN_POSITION.clone().normalize() },
      uSunTint: { value: new THREE.Color(0x4a2a0c) },
      uEarthDirection: { value: EARTH_POSITION.clone().normalize() },
      uEarthTint: { value: new THREE.Color(0x0b3a5e) },
    },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uSunDirection;
      uniform vec3 uSunTint;
      uniform vec3 uEarthDirection;
      uniform vec3 uEarthTint;
      varying vec3 vDirection;
      void main() {
        vec3 direction = normalize(vDirection);
        float altitude = smoothstep(-0.1, 0.5, direction.y);
        vec3 color = mix(uHorizon, uZenith, altitude);
        float sunGlow = pow(max(dot(direction, uSunDirection), 0.0), 18.0);
        color += uSunTint * sunGlow;
        float earthGlow = pow(max(dot(direction, uEarthDirection), 0.0), 26.0);
        color += uEarthTint * earthGlow * 0.9;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(760, 48, 24), material);
  sky.name = "sky-dome";
  sky.frustumCulled = false;
  return sky;
}

function createTwinkleMaterial({ twinkle, softness }) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uTwinkle: { value: twinkle },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uTwinkle;
      varying vec3 vColor;
      varying float vIntensity;
      void main() {
        vColor = color;
        float wave = sin(uTime * (0.9 + aPhase * 2.4) + aPhase * 6.2831853);
        float pulse = 1.0 - uTwinkle * 0.5 + uTwinkle * 0.5 * wave;
        vIntensity = pulse;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (0.75 + 0.25 * pulse);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vIntensity;
      void main() {
        vec2 offset = gl_PointCoord - 0.5;
        float distance = length(offset) * 2.0;
        float alpha = smoothstep(1.0, ${softness.toFixed(2)}, distance);
        gl_FragColor = vec4(vColor * vIntensity, alpha);
      }
    `,
  });
}

export function createStarField() {
  const count = 2600;
  const random = mulberry32(0x53544152);
  const positions = [];
  const colors = [];
  const sizes = [];
  const phases = [];
  const color = new THREE.Color();
  const radius = 640;
  while (positions.length < count * 3) {
    const theta = random() * Math.PI * 2;
    const altitude = 0.01 + Math.pow(random(), 0.85) * 0.99;
    const ring = Math.sqrt(1 - altitude * altitude);
    const x = Math.cos(theta) * ring;
    const z = Math.sin(theta) * ring;
    if (z > 0.15) continue;
    positions.push(x * radius, altitude * radius, z * radius);
    const brightRoll = random();
    const size = brightRoll > 0.965 ? 4.4 + random() * 2.4 : 1.4 + Math.pow(random(), 2) * 2.2;
    sizes.push(size);
    phases.push(random());
    const hueRoll = random();
    if (hueRoll < 0.55) color.setHSL(0.58, 0.25, 0.86 + random() * 0.14);
    else if (hueRoll < 0.8) color.setHSL(0.52, 0.55, 0.78 + random() * 0.18);
    else color.setHSL(0.1, 0.55, 0.82 + random() * 0.14);
    color.multiplyScalar(brightRoll > 0.965 ? 1.4 : 0.55 + random() * 0.55);
    colors.push(color.r, color.g, color.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.Float32BufferAttribute(phases, 1));
  const stars = new THREE.Points(geometry, createTwinkleMaterial({ twinkle: 0.7, softness: 0.15 }));
  stars.name = "star-field";
  stars.frustumCulled = false;
  return stars;
}

export function createMilkyWay() {
  const count = 3600;
  const random = mulberry32(0x4d494c4b);
  const positions = [];
  const colors = [];
  const sizes = [];
  const phases = [];
  const color = new THREE.Color();
  const radius = 660;
  for (let index = 0; index < count; index += 1) {
    const t = random();
    // The band sweeps from behind the sun (upper-left) down towards Earth (right).
    const azimuth = lerp(-1.25, 1.05, t) + (random() - 0.5) * 0.08;
    const elevation = lerp(0.78, 0.1, t) + (random() - 0.5) * 0.14 * (0.6 + random());
    const clump = random() < 0.35 ? (random() - 0.5) * 0.04 : (random() - 0.5) * 0.28;
    const finalElevation = elevation + clump;
    const ring = Math.cos(finalElevation);
    positions.push(Math.sin(azimuth) * ring * radius, Math.sin(finalElevation) * radius, -Math.cos(azimuth) * ring * radius);
    sizes.push(2 + Math.pow(random(), 1.6) * 6);
    phases.push(random());
    const hue = random() < 0.7 ? 0.55 + random() * 0.08 : 0.72 + random() * 0.08;
    color.setHSL(hue, 0.5, 0.6 + random() * 0.3);
    color.multiplyScalar(0.08 + Math.pow(random(), 2.2) * 0.26);
    colors.push(color.r, color.g, color.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 1));
  geometry.setAttribute("aPhase", new THREE.Float32BufferAttribute(phases, 1));
  const points = new THREE.Points(geometry, createTwinkleMaterial({ twinkle: 0.15, softness: 0.0 }));
  points.name = "milky-way";
  points.frustumCulled = false;
  return points;
}

export function createNebulaHaze({ radialGlowTexture }) {
  const group = new THREE.Group();
  group.name = "nebula-haze";
  const random = mulberry32(0x4e454255);
  const texture = radialGlowTexture([
    [0, "rgba(255,255,255,0.9)"],
    [0.35, "rgba(255,255,255,0.32)"],
    [1, "rgba(255,255,255,0)"],
  ]);
  const radius = 690;
  for (let index = 0; index < 7; index += 1) {
    const t = index / 6;
    const azimuth = lerp(-1.2, 1.0, t) + (random() - 0.5) * 0.12;
    const elevation = lerp(0.76, 0.12, t) + (random() - 0.5) * 0.1;
    const ring = Math.cos(elevation);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
      color: new THREE.Color().setHSL(index % 3 === 0 ? 0.68 : 0.55, 0.6, 0.5),
      opacity: 0.025 + random() * 0.02,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(Math.sin(azimuth) * ring * radius, Math.sin(elevation) * radius, -Math.cos(azimuth) * ring * radius);
    const size = 150 + random() * 170;
    sprite.scale.set(size * (1.3 + random() * 0.8), size, 1);
    group.add(sprite);
  }
  return group;
}

export class ShootingStar {
  constructor(parent, { canvasTexture }) {
    this.random = mulberry32(0x53484f54);
    const texture = canvasTexture(256, 32, (context, width, height) => {
      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "rgba(160,220,255,0)");
      gradient.addColorStop(0.75, "rgba(200,235,255,0.55)");
      gradient.addColorStop(0.96, "rgba(255,255,255,1)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.moveTo(0, height / 2);
      context.lineTo(width * 0.93, 0);
      context.lineTo(width, height / 2);
      context.lineTo(width * 0.93, height);
      context.closePath();
      context.fill();
    });
    this.material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.name = "shooting-star";
    this.sprite.visible = false;
    parent.add(this.sprite);
    this.active = false;
    this.nextSpawnAt = 3.5;
    this.start = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.length = 0;
    this.duration = 1;
    this.progress = 0;
  }

  spawn(elapsed) {
    const { random } = this;
    this.start.set((random() - 0.5) * 520, 130 + random() * 150, -560);
    const horizontal = random() < 0.5 ? -1 : 1;
    const slope = 0.35 + random() * 0.55;
    this.direction.set(Math.cos(slope) * horizontal, -Math.sin(slope), 0);
    this.length = 70 + random() * 90;
    this.duration = 0.9 + random() * 0.7;
    this.progress = 0;
    this.material.rotation = Math.atan2(this.direction.y, this.direction.x);
    this.sprite.scale.set(this.length * 0.32, 2.2, 1);
    this.sprite.visible = true;
    this.active = true;
    this.nextSpawnAt = elapsed;
  }

  update(elapsed, delta) {
    if (!this.active) {
      if (elapsed >= this.nextSpawnAt) this.spawn(elapsed);
      return;
    }
    this.progress += delta / this.duration;
    if (this.progress >= 1) {
      this.active = false;
      this.sprite.visible = false;
      this.nextSpawnAt = elapsed + 6 + this.random() * 10;
      return;
    }
    const eased = this.progress;
    this.sprite.position.copy(this.start).addScaledVector(this.direction, eased * this.length);
    this.material.opacity = Math.sin(Math.PI * eased) * 0.85;
  }
}
