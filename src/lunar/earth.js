import * as THREE from "three";
import { SUN_POSITION, EARTH_POSITION, EARTH_RADIUS } from "./constants.js";
import { clamp01, smoothstep, mulberry32, fbm3 } from "./noise.js";

const EARTH_COLORS = {
  oceanDeep: new THREE.Color(0x0a3b72),
  oceanShallow: new THREE.Color(0x2597c9),
  forest: new THREE.Color(0x2f7d3c),
  lowland: new THREE.Color(0x5fac48),
  hills: new THREE.Color(0x98a54c),
  highland: new THREE.Color(0xb59a60),
  mountain: new THREE.Color(0x9c9187),
  snow: new THREE.Color(0xf2f4f1),
  desert: new THREE.Color(0xd6b673),
  ice: new THREE.Color(0xe9f1f5),
};

function createEarthSurface() {
  const geometry = new THREE.IcosahedronGeometry(EARTH_RADIUS, 13);
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const random = mulberry32(0x45415254);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const color = new THREE.Color();
  const mixed = new THREE.Color();

  for (let face = 0; face < positions.count / 3; face += 1) {
    const index = face * 3;
    a.fromBufferAttribute(positions, index);
    b.fromBufferAttribute(positions, index + 1);
    c.fromBufferAttribute(positions, index + 2);
    normal.copy(a).add(b).add(c).divideScalar(3).normalize();

    const warpX = fbm3(normal.x * 1.4 + 5.1, normal.y * 1.4, normal.z * 1.4, 3) * 0.32;
    const warpZ = fbm3(normal.x * 1.4, normal.y * 1.4 + 2.7, normal.z * 1.4 + 9.3, 3) * 0.32;
    const continent = fbm3((normal.x + warpX) * 1.85, normal.y * 1.85 + 1.3, (normal.z + warpZ) * 1.85, 5);
    const detail = fbm3(normal.x * 6.8 + 2, normal.y * 6.8, normal.z * 6.8 - 4, 3);
    const elevation = continent + detail * 0.22;
    const seaLevel = 0.05;
    const polar = smoothstep(0.83, 0.92, Math.abs(normal.y) + detail * 0.05);

    let landHeight = 0;
    if (elevation < seaLevel) {
      const depth = Math.pow(clamp01((seaLevel - elevation) / 0.45), 0.55);
      color.lerpColors(EARTH_COLORS.oceanShallow, EARTH_COLORS.oceanDeep, depth);
    } else {
      landHeight = clamp01((elevation - seaLevel) / 0.5);
      if (landHeight < 0.3) color.lerpColors(EARTH_COLORS.forest, EARTH_COLORS.lowland, landHeight / 0.3);
      else if (landHeight < 0.6) color.lerpColors(EARTH_COLORS.lowland, EARTH_COLORS.hills, (landHeight - 0.3) / 0.3);
      else if (landHeight < 0.85) color.lerpColors(EARTH_COLORS.hills, EARTH_COLORS.mountain, (landHeight - 0.6) / 0.25);
      else color.lerpColors(EARTH_COLORS.mountain, EARTH_COLORS.snow, (landHeight - 0.85) / 0.15);
      const dryBand = 1 - Math.abs(Math.abs(normal.y) - 0.4) / 0.14;
      const dryness = clamp01(dryBand + detail * 0.45) * (landHeight < 0.6 ? 1 : 0.3);
      mixed.copy(color).lerp(EARTH_COLORS.desert, dryness * 0.8);
      color.copy(mixed);
    }
    color.lerp(EARTH_COLORS.ice, polar);
    color.offsetHSL(0, 0, (random() - 0.5) * 0.05);

    for (let vertex = 0; vertex < 3; vertex += 1) {
      colors[(index + vertex) * 3] = color.r;
      colors[(index + vertex) * 3 + 1] = color.g;
      colors[(index + vertex) * 3 + 2] = color.b;
    }

    if (landHeight > 0) {
      const lift = 1 + landHeight * 0.022 + 0.004;
      a.multiplyScalar(lift);
      b.multiplyScalar(lift);
      c.multiplyScalar(lift);
      positions.setXYZ(index, a.x, a.y, a.z);
      positions.setXYZ(index + 1, b.x, b.y, b.z);
      positions.setXYZ(index + 2, c.x, c.y, c.z);
    }
  }
  // Adjacent flat-colored faces share the same relief at a common corner.
  // Lifting each triangle independently left cracks revealing the blue rim.
  const relief = new Map();
  const vertexKey = (p) => `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`;
  for (let i = 0; i < positions.count; i++) {
    a.fromBufferAttribute(positions, i);
    const radius = a.length(); a.normalize();
    const key = vertexKey(a), sample = relief.get(key) ?? { total: 0, count: 0 };
    sample.total += radius; sample.count++; relief.set(key, sample);
  }
  for (let i = 0; i < positions.count; i++) {
    a.fromBufferAttribute(positions, i).normalize();
    const sample = relief.get(vertexKey(a));
    a.multiplyScalar(sample.total / sample.count); positions.setXYZ(i, a.x, a.y, a.z);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const surface = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.72,
      metalness: 0,
      emissive: new THREE.Color(0x0a1c32),
      emissiveIntensity: 0.45,
      fog: false,
    }),
  );
  surface.name = "earth-surface";
  return surface;
}

function createEarthClouds() {
  const source = new THREE.IcosahedronGeometry(EARTH_RADIUS * 1.028, 9);
  const positions = source.attributes.position;
  const kept = [];
  const colors = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let face = 0; face < positions.count / 3; face += 1) {
    const index = face * 3;
    a.fromBufferAttribute(positions, index);
    b.fromBufferAttribute(positions, index + 1);
    c.fromBufferAttribute(positions, index + 2);
    normal.copy(a).add(b).add(c).divideScalar(3).normalize();
    let cover = fbm3(normal.x * 3.1 + 11, normal.y * 3.1, normal.z * 3.1 + 4, 4);
    cover += fbm3(normal.x * 7.5, normal.y * 7.5 + 3, normal.z * 7.5, 2) * 0.35;
    cover += Math.sin(normal.y * 9.5 + 0.4) * 0.14;
    const alpha = smoothstep(0.16, 0.5, cover) * 0.92;
    if (alpha < 0.04) continue;
    kept.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let vertex = 0; vertex < 3; vertex += 1) colors.push(1, 1, 1, alpha);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(kept, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 4));
  geometry.computeVertexNormals();
  const clouds = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      transparent: true,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      emissive: new THREE.Color(0x1d2f45),
      emissiveIntensity: 0.4,
      fog: false,
    }),
  );
  clouds.name = "earth-clouds";
  return clouds;
}

function createAtmosphereShell(radius, side, power, innerColor, outerColor, strength) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 64, 40),
    new THREE.ShaderMaterial({
      side,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uInner: { value: new THREE.Color(innerColor) },
        uOuter: { value: new THREE.Color(outerColor) },
        uPower: { value: power },
        uStrength: { value: strength },
      },
      vertexShader: `
        varying vec3 vWorldNormal;
        varying vec3 vWorldPosition;
        void main() {
          vWorldNormal = normalize(mat3(modelMatrix) * normal);
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorldPosition = world.xyz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: `
        uniform vec3 uInner;
        uniform vec3 uOuter;
        uniform float uPower;
        uniform float uStrength;
        varying vec3 vWorldNormal;
        varying vec3 vWorldPosition;
        void main() {
          vec3 viewDirection = normalize(cameraPosition - vWorldPosition);
          float facing = dot(normalize(vWorldNormal), viewDirection);
          float rim = pow(clamp(1.0 - abs(facing), 0.0, 1.0), uPower);
          vec3 glow = mix(uInner, uOuter, rim);
          gl_FragColor = vec4(glow * rim * uStrength, rim * uStrength);
        }
      `,
    }),
  );
}

export function createEarth({ radialGlowTexture }) {
  const earth = new THREE.Group();
  earth.name = "earth-system";
  earth.position.copy(EARTH_POSITION);

  const spin = new THREE.Group();
  spin.name = "earth-spin";
  spin.rotation.set(0.12, 0, 0.32);
  const surface = createEarthSurface();
  const clouds = createEarthClouds();
  // The planets are deliberately staged at cinematic distances. At Earth's
  // position the direction toward the visible sun is not the moon's direction.
  // Use that actual vector for the planet's key light, keeping the same PBR.
  const sunDirection = { value: SUN_POSITION.clone().sub(EARTH_POSITION).normalize() };
  for (const material of [surface.material, clouds.material]) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uEarthSunDirection = sunDirection;
      shader.fragmentShader = "uniform vec3 uEarthSunDirection;\n" + shader.fragmentShader.replace(
        "#include <lights_fragment_begin>",
        THREE.ShaderChunk.lights_fragment_begin.replace(
          "getDirectionalLightInfo( directionalLight, directLight );",
          `getDirectionalLightInfo( directionalLight, directLight );
           #if UNROLLED_LOOP_INDEX == 0
             directLight.direction = normalize(mat3(viewMatrix) * uEarthSunDirection);
           #endif`,
        ),
      );
    };
    material.customProgramCacheKey = () => "earth-sun-direction-v1";
  }
  spin.add(surface, clouds);

  const innerRim = createAtmosphereShell(EARTH_RADIUS * 1.03, THREE.FrontSide, 3.2, 0x2f8fd8, 0x9fe4ff, 1.15);
  innerRim.name = "earth-atmosphere-rim";
  const outerHalo = createAtmosphereShell(EARTH_RADIUS * 1.035, THREE.BackSide, 4.5, 0x0c3e78, 0x39b7ff, 0.8);
  outerHalo.name = "earth-atmosphere-halo";

  const backGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialGlowTexture([
      [0, "rgba(120,200,255,0.55)"],
      [0.4, "rgba(60,150,255,0.18)"],
      [1, "rgba(30,90,200,0)"],
    ]),
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    opacity: 0.4,
  }));
  backGlow.name = "earth-back-glow";
  backGlow.scale.setScalar(EARTH_RADIUS * 2.4);
  backGlow.position.z = -6;

  earth.add(backGlow, spin, innerRim, outerHalo);
  earth.userData.surface = surface;
  earth.userData.clouds = clouds;
  earth.userData.spin = spin;
  earth.userData.sunDirection = sunDirection;
  return earth;
}
