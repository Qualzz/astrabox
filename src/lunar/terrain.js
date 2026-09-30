import * as THREE from "three";
import { PLATFORM_POSITION, PLATFORM_GROUND, TERRAIN_Z_NEAR, TERRAIN_Z_FAR } from "./constants.js";
import { lerp, smoothstep, mulberry32, fbm, hashNoise } from "./noise.js";

const craterRandom = mulberry32(0x4d4f4f4e);
const craters = [
  { x: 15, z: -31, radius: 7.5, depth: 1.15 },
  { x: -27, z: -46, radius: 6, depth: 0.95 },
  { x: 9, z: 2, radius: 3.4, depth: 0.55 },
  ...Array.from({ length: 30 }, (_, index) => {
    const depthBias = craterRandom();
    const z = 14 - Math.pow(depthBias, 0.72) * 84;
    return {
      x: (craterRandom() - 0.5) * (60 + Math.max(0, -z) * 0.9),
      z,
      radius: 0.8 + craterRandom() * (index < 6 ? 3.6 : 2.2),
      depth: 0.22 + craterRandom() * 0.7,
    };
  }),
];

export function terrainHeight(x, z) {
  let height = -0.45;
  height += fbm(x * 0.042 + 3.1, z * 0.042) * 1.35;
  height += fbm(x * 0.11 + 17.3, z * 0.11 - 9.1) * 0.34;
  height += fbm(x * 0.32, z * 0.32 + 4.4, 2) * 0.08;

  for (const crater of craters) {
    const normalized = Math.hypot(x - crater.x, z - crater.z) / crater.radius;
    if (normalized < 1.5) {
      const bowl = normalized < 1 ? -Math.pow(1 - normalized, 1.6) * crater.depth : 0;
      const rim = Math.exp(-Math.pow((normalized - 1.04) / 0.18, 2)) * crater.depth * 0.5;
      height += bowl + rim;
    }
  }

  const ridge = smoothstep(-50, -90, z);
  const ridgeProfile = 2.4 + Math.max(0, fbm(x * 0.026 + 3.3, 7.7)) * 4.2 + fbm(x * 0.085, 2.2, 3) * 0.7;
  height += ridge * ridgeProfile;
  height -= Math.pow(Math.abs(x) / 100, 2) * 6.5 * smoothstep(-25, -90, z);

  const platformDistance = Math.hypot(x - PLATFORM_POSITION.x, z - PLATFORM_POSITION.z);
  height = lerp(height, PLATFORM_GROUND, 1 - smoothstep(7, 12, platformDistance));
  return height;
}

export function createTerrain() {
  const columns = 124;
  const rows = 100;
  const positions = [];
  const colors = [];
  const color = new THREE.Color();
  const random = mulberry32(0x5245474f);

  const rowZ = (row) => lerp(TERRAIN_Z_NEAR, TERRAIN_Z_FAR, Math.pow(row / rows, 1.22));
  const rowHalfWidth = (row) => lerp(36, 108, row / rows);

  const point = (column, row) => {
    const halfWidth = rowHalfWidth(row);
    const cellX = (halfWidth * 2) / columns;
    const cellZ = Math.abs(rowZ(Math.min(rows, row + 1)) - rowZ(Math.max(0, row - 1))) * 0.5;
    const edge = column === 0 || column === columns || row === 0 || row === rows;
    const jitter = edge ? 0 : 0.42;
    const x = lerp(-halfWidth, halfWidth, column / columns) + hashNoise(column * 7.13, row * 3.71) * cellX * jitter;
    const z = rowZ(row) + hashNoise(column * 1.97, row * 5.31) * cellZ * jitter;
    return [x, terrainHeight(x, z), z];
  };

  const addFace = (a, b, c) => {
    positions.push(...a, ...b, ...c);
    const averageHeight = (a[1] + b[1] + c[1]) / 3;
    const averageZ = (a[2] + b[2] + c[2]) / 3;
    const far = smoothstep(-20, TERRAIN_Z_FAR, averageZ);
    // Darker foreground, brighter mid-ground: gives the shot depth layering.
    const depthLift = smoothstep(12, -30, averageZ);
    const lightness = THREE.MathUtils.clamp(
      lerp(0.3, 0.5, depthLift) + averageHeight * 0.016 + (random() - 0.5) * 0.07,
      0.24,
      0.64,
    );
    color.setHSL(lerp(0.57, 0.56, far), lerp(0.04, 0.07, far), lightness);
    for (let vertex = 0; vertex < 3; vertex += 1) colors.push(color.r, color.g, color.b);
  };

  const cache = new Map();
  const cachedPoint = (column, row) => {
    const key = row * (columns + 1) + column;
    let value = cache.get(key);
    if (!value) {
      value = point(column, row);
      cache.set(key, value);
    }
    return value;
  };

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const a = cachedPoint(column, row);
      const b = cachedPoint(column + 1, row);
      const c = cachedPoint(column, row + 1);
      const d = cachedPoint(column + 1, row + 1);
      if (hashNoise(column * 0.37, row * 0.91) > 0) {
        addFace(a, b, c);
        addFace(b, d, c);
      } else {
        addFace(a, b, d);
        addFace(a, d, c);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const terrain = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.01,
      flatShading: true,
    }),
  );
  terrain.name = "low-poly-lunar-terrain";
  terrain.receiveShadow = true;
  return terrain;
}

export function createRocks() {
  const group = new THREE.Group();
  group.name = "lunar-rock-field";
  const random = mulberry32(0x524f434b);
  const material = new THREE.MeshStandardMaterial({
    color: 0x8f949a,
    roughness: 0.98,
    metalness: 0.01,
    flatShading: true,
  });
  const geometries = [
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.OctahedronGeometry(1, 1),
  ];
  const transform = new THREE.Object3D();
  const tint = new THREE.Color();

  const placements = [];
  const tryPlace = (x, z, scale) => {
    const platformDistance = Math.hypot(x - PLATFORM_POSITION.x, z - PLATFORM_POSITION.z);
    if (platformDistance < 9.5 + scale) return false;
    if (Math.abs(x) < 7 && z > 4) return false;
    placements.push({ x, z, scale });
    return true;
  };

  for (let index = 0; index < 170; index += 1) {
    const depth = Math.pow(random(), 1.25);
    const z = 14 - depth * 102;
    const halfWidth = lerp(28, 100, depth);
    let x = (random() - 0.5) * halfWidth * 2;
    const ridgeRock = index < 18;
    if (ridgeRock) x = (random() - 0.5) * 200;
    const perspectiveScale = lerp(0.8, 1.35, depth);
    let scale = perspectiveScale * (0.28 + Math.pow(random(), 2.6) * (ridgeRock ? 3.2 : 1.7));
    // Keep the foreground readable: nothing massive right in front of the camera.
    if (z > -6) scale = Math.min(scale, 0.75);
    if (ridgeRock && x > 22 && x < 72) scale = Math.min(scale, 1.6);
    tryPlace(x, ridgeRock ? -84 - random() * 9 : z, scale);
  }
  tryPlace(15, -7, 1.7);
  tryPlace(23, -15, 2.1);
  tryPlace(-27, -9, 1.9);
  tryPlace(32, -27, 2.6);
  tryPlace(-38, -34, 3.1);

  const perGeometry = geometries.map(() => []);
  placements.forEach((placement, index) => perGeometry[index % geometries.length].push(placement));

  perGeometry.forEach((list, geometryIndex) => {
    if (list.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometries[geometryIndex], material, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    list.forEach((placement, index) => {
      const { x, z, scale } = placement;
      transform.position.set(x, terrainHeight(x, z) + scale * 0.32, z);
      transform.rotation.set(random() * 1.4, random() * Math.PI * 2, random() * 0.6);
      transform.scale.set(
        scale * (0.8 + random() * 0.7),
        scale * (0.55 + random() * 0.6),
        scale * (0.75 + random() * 0.85),
      );
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      tint.setHSL(0.57, 0.03 + random() * 0.03, 0.3 + random() * 0.18);
      mesh.setColorAt(index, tint);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  });
  return group;
}
