import * as THREE from "three";
import { PALETTE, PLATFORM_POSITION, PLATFORM_GROUND } from "./constants.js";
import { mulberry32 } from "./noise.js";

function drawDeckDecal(context, size, { background, line, glow }) {
  const center = size / 2;
  const radius = size / 2;
  context.fillStyle = background;
  context.fillRect(0, 0, size, size);
  context.lineCap = "round";

  const ring = (fraction, width, alpha = 1) => {
    context.globalAlpha = alpha;
    context.lineWidth = width;
    context.strokeStyle = line;
    context.beginPath();
    context.arc(center, center, radius * fraction, 0, Math.PI * 2);
    context.stroke();
  };
  const polygon = (fraction, sides, width, rotation = 0, alpha = 1) => {
    context.globalAlpha = alpha;
    context.lineWidth = width;
    context.strokeStyle = line;
    context.beginPath();
    for (let index = 0; index <= sides; index += 1) {
      const angle = rotation + (index / sides) * Math.PI * 2;
      const x = center + Math.cos(angle) * radius * fraction;
      const y = center + Math.sin(angle) * radius * fraction;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.stroke();
  };

  ring(0.965, 6);
  ring(0.9, 2, 0.55);
  for (let tick = 0; tick < 72; tick += 1) {
    const angle = (tick / 72) * Math.PI * 2;
    const major = tick % 6 === 0;
    const inner = radius * (major ? 0.8 : 0.85);
    const outer = radius * 0.885;
    context.globalAlpha = major ? 1 : 0.6;
    context.lineWidth = major ? 5 : 2.5;
    context.strokeStyle = line;
    context.beginPath();
    context.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
    context.lineTo(center + Math.cos(angle) * outer, center + Math.sin(angle) * outer);
    context.stroke();
  }
  polygon(0.7, 8, 3, Math.PI / 8, 0.75);
  ring(0.46, 10);
  polygon(0.3, 6, 4, Math.PI / 6, 0.9);

  // Chevrons pointing towards the front edge (+v in texture space = +z in world).
  for (let chevron = 0; chevron < 3; chevron += 1) {
    const offset = radius * (0.53 + chevron * 0.06);
    context.globalAlpha = 1 - chevron * 0.28;
    context.lineWidth = 8;
    context.strokeStyle = glow;
    context.beginPath();
    context.moveTo(center - radius * 0.12, center + offset - radius * 0.05);
    context.lineTo(center, center + offset);
    context.lineTo(center + radius * 0.12, center + offset - radius * 0.05);
    context.stroke();
  }
  context.globalAlpha = 1;
}

export function createPlatform({ environmentMap = null, canvasTexture }) {
  const group = new THREE.Group();
  group.name = "robot-platform";
  group.position.set(PLATFORM_POSITION.x, PLATFORM_GROUND, PLATFORM_POSITION.z);

  const metal = (color, roughness, metalness) => new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    flatShading: true,
    envMap: environmentMap,
    envMapIntensity: 0.9,
  });
  const metalDark = metal(PALETTE.metalDark, 0.46, 0.78);
  const metalMid = metal(PALETTE.metalMid, 0.5, 0.65);
  const metalLight = metal(PALETTE.metalLight, 0.55, 0.55);
  const accent = new THREE.MeshStandardMaterial({
    color: 0x0a2a29,
    emissive: new THREE.Color(PALETTE.accent),
    emissiveIntensity: 2.6,
    roughness: 0.35,
    metalness: 0.1,
  });
  const accentWarm = new THREE.MeshStandardMaterial({
    color: 0x2a1604,
    emissive: new THREE.Color(PALETTE.accentWarm),
    emissiveIntensity: 2.2,
    roughness: 0.4,
  });

  const solid = (mesh) => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Foot slab (hexagonal) + emissive seam.
  const foot = solid(new THREE.Mesh(new THREE.CylinderGeometry(6.1, 6.6, 0.5, 6), metalDark));
  foot.position.y = 0.25;
  foot.rotation.y = Math.PI / 6;
  const footSeam = new THREE.Mesh(new THREE.TorusGeometry(5.65, 0.05, 6, 6), accent);
  footSeam.rotation.x = Math.PI / 2;
  footSeam.rotation.z = Math.PI / 6;
  footSeam.position.y = 0.51;
  group.add(footSeam);

  // Central octagonal column with light slits.
  const columnHeight = 3.0;
  const column = solid(new THREE.Mesh(new THREE.CylinderGeometry(2.75, 3.05, columnHeight, 8), metalMid));
  column.position.y = 0.5 + columnHeight / 2;
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2 + Math.PI / 8;
    const slit = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.9, 0.1), accent);
    slit.position.set(Math.cos(angle) * 2.92, 0.5 + columnHeight / 2, Math.sin(angle) * 2.92);
    slit.rotation.y = -angle + Math.PI / 2;
    group.add(slit);
  }

  // Support fins leaning outward from foot to deck, each with a light strip.
  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2 + Math.PI / 6;
    const pivot = new THREE.Group();
    pivot.rotation.y = -angle;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.42, columnHeight, 1.05), metalDark);
    fin.position.set(4.25, 0.5 + columnHeight / 2, 0);
    fin.rotation.z = -0.19;
    fin.castShadow = true;
    fin.receiveShadow = true;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.05, columnHeight * 0.72, 0.16), accent);
    strip.position.set(4.25 + 0.23, 0.5 + columnHeight / 2, 0);
    strip.rotation.z = -0.19;
    pivot.add(fin, strip);
    group.add(pivot);
  }

  // Deck.
  const deckThickness = 0.55;
  const deckBaseY = 0.5 + columnHeight;
  const deck = solid(new THREE.Mesh(new THREE.CylinderGeometry(5.25, 4.55, deckThickness, 8), metalLight));
  deck.position.y = deckBaseY + deckThickness / 2;
  deck.rotation.y = Math.PI / 8;
  const deckTopY = deckBaseY + deckThickness;

  const decalMap = canvasTexture(1024, 1024, (context, size) => drawDeckDecal(context, size, {
    background: "#2b333d",
    line: "#5c6b78",
    glow: "#5c6b78",
  }));
  const decalEmissive = canvasTexture(1024, 1024, (context, size) => drawDeckDecal(context, size, {
    background: "#000000",
    line: "#4df2e2",
    glow: "#8dfff3",
  }));
  const plate = new THREE.Mesh(
    new THREE.CircleGeometry(4.55, 8, Math.PI / 8),
    new THREE.MeshStandardMaterial({
      map: decalMap,
      emissive: new THREE.Color(0xffffff),
      emissiveMap: decalEmissive,
      emissiveIntensity: 1.7,
      roughness: 0.5,
      metalness: 0.4,
      envMap: environmentMap,
      envMapIntensity: 0.6,
    }),
  );
  plate.name = "platform-deck-plate";
  plate.rotation.x = -Math.PI / 2;
  plate.position.y = deckTopY + 0.005;
  plate.receiveShadow = true;
  group.add(plate);

  const deckRim = new THREE.Mesh(new THREE.TorusGeometry(5.05, 0.075, 8, 8), accent);
  deckRim.name = "platform-light-ring";
  deckRim.rotation.x = Math.PI / 2;
  deckRim.rotation.z = Math.PI / 8;
  deckRim.position.y = deckTopY - 0.02;
  group.add(deckRim);

  // Beacon posts with blinking warm tips.
  const beacons = [];
  for (let index = 0; index < 4; index += 1) {
    const angle = (index / 4) * Math.PI * 2 + Math.PI / 4;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.95, 6), metalDark);
    post.position.set(Math.cos(angle) * 4.7, deckTopY + 0.475, Math.sin(angle) * 4.7);
    post.castShadow = true;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), accentWarm.clone());
    tip.position.set(Math.cos(angle) * 4.7, deckTopY + 1.0, Math.sin(angle) * 4.7);
    beacons.push({ tip, phase: index * 0.7 });
    group.add(post, tip);
  }

  // Segmented holographic rings orbiting the deck.
  const holoMaterial = new THREE.MeshBasicMaterial({
    color: PALETTE.accent,
    transparent: true,
    opacity: 0.6,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const holoRings = [];
  const ringSpecs = [
    { radius: 5.85, y: deckTopY + 0.35, tilt: 0.06, speed: 0.22, segments: 3, arc: 1.7 },
    { radius: 6.5, y: deckTopY + 0.7, tilt: -0.05, speed: -0.15, segments: 4, arc: 1.1 },
  ];
  for (const spec of ringSpecs) {
    const ring = new THREE.Group();
    ring.position.y = spec.y;
    ring.rotation.x = spec.tilt;
    for (let index = 0; index < spec.segments; index += 1) {
      const segment = new THREE.Mesh(new THREE.TorusGeometry(spec.radius, 0.035, 4, 48, spec.arc), holoMaterial);
      segment.rotation.x = Math.PI / 2;
      segment.rotation.z = (index / spec.segments) * Math.PI * 2;
      ring.add(segment);
    }
    holoRings.push({ ring, speed: spec.speed });
    group.add(ring);
  }

  // Power conduits running from the foot into the regolith.
  const conduitMaterial = metal(0x2a3038, 0.55, 0.6);
  const conduits = [
    [new THREE.Vector3(5.2, 0.35, 2.2), new THREE.Vector3(8.5, 0.15, 4.6), new THREE.Vector3(12.5, -0.15, 6.0)],
    [new THREE.Vector3(-3.5, 0.35, 5.4), new THREE.Vector3(-5.5, 0.1, 8.6), new THREE.Vector3(-8, -0.2, 11.5)],
  ];
  for (const points of conduits) {
    const curve = new THREE.CatmullRomCurve3(points);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.22, 6, false), conduitMaterial);
    tube.castShadow = true;
    tube.receiveShadow = true;
    group.add(tube);
  }

  // Lights.
  const underGlow = new THREE.PointLight(PALETTE.accent, 34, 22, 2);
  underGlow.position.y = deckBaseY - 0.2;
  group.add(underGlow);
  const rimLight = new THREE.PointLight(PALETTE.accent, 14, 14, 2);
  rimLight.position.set(0.5, deckTopY + 2.5, -3.6);
  group.add(rimLight);

  // Soft contact shadow under the robot.
  const contactShadow = new THREE.Mesh(
    new THREE.CircleGeometry(2.7, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
  );
  contactShadow.name = "robot-contact-shadow";
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.y = deckTopY + 0.012;
  group.add(contactShadow);

  const position = group.position.clone();
  return {
    group,
    position,
    topY: position.y + deckTopY,
    deckTopY,
    beacons,
    holoRings,
  };
}

export function createEnergyParticles(platform) {
  const count = 110;
  const random = mulberry32(0x50415254);
  const angles = new Float32Array(count);
  const radii = new Float32Array(count);
  const speeds = new Float32Array(count);
  const seeds = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    angles[index] = random() * Math.PI * 2;
    radii[index] = 4.9 + random() * 1.9;
    speeds[index] = 0.06 + random() * 0.08;
    seeds[index] = random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
  geometry.setAttribute("aAngle", new THREE.BufferAttribute(angles, 1));
  geometry.setAttribute("aRadius", new THREE.BufferAttribute(radii, 1));
  geometry.setAttribute("aSpeed", new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: 1 },
      uColor: { value: new THREE.Color(PALETTE.accent) },
      uBaseY: { value: platform.deckTopY - 0.6 },
      uHeight: { value: 7.5 },
      uFocus: { value: 0 },
      uPresence: { value: 0 },
    },
    vertexShader: `
      attribute float aAngle;
      attribute float aRadius;
      attribute float aSpeed;
      attribute float aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uBaseY;
      uniform float uHeight;
      uniform float uFocus;
      varying float vAlpha;
      void main() {
        float life = fract(aSeed + uTime * aSpeed);
        float angle = aAngle + uTime * 0.18;
        vec3 local = vec3(cos(angle) * aRadius, uBaseY + life * uHeight, sin(angle) * aRadius);
        vAlpha = sin(life * 3.14159) * (0.35 + 0.65 * aSeed);
        vec4 mvPosition = modelViewMatrix * vec4(local, 1.0);
        gl_PointSize = (1.6 + aSeed * 2.2) * uPixelRatio * (180.0 / -mvPosition.z);
        // Close-up sparks must not become huge blobs covering the TV face.
        gl_PointSize = mix(gl_PointSize, min(gl_PointSize, 8.0 * uPixelRatio), uFocus);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uPresence;
      varying float vAlpha;
      void main() {
        float distance = length(gl_PointCoord - 0.5) * 2.0;
        float alpha = smoothstep(1.0, 0.2, distance) * vAlpha * uPresence;
        gl_FragColor = vec4(uColor * 1.4, alpha);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.name = "platform-energy-particles";
  points.frustumCulled = false;
  platform.group.add(points);
  return points;
}
