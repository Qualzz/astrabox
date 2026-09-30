import { MathUtils } from "three";

// Seeded, stateless geometry noise shared by sky, planets and terrain.
export const { lerp } = MathUtils;
export const clamp01 = (value) => Math.max(0, Math.min(1, value));
export const smoothstep = (edge0, edge1, value) => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

export function mulberry32(seed) {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashNoise(x, z) {
  const value = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return (value - Math.floor(value)) * 2 - 1;
}

export function valueNoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hashNoise(ix, iz);
  const b = hashNoise(ix + 1, iz);
  const c = hashNoise(ix, iz + 1);
  const d = hashNoise(ix + 1, iz + 1);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uz);
}

export function fbm(x, z, octaves = 5) {
  let value = 0;
  let amplitude = 0.58;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    value += valueNoise(x * frequency, z * frequency) * amplitude;
    frequency *= 2.04;
    amplitude *= 0.48;
  }
  return value;
}

export function hash3(x, y, z) {
  const value = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return (value - Math.floor(value)) * 2 - 1;
}

export function valueNoise3(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const uz = fz * fz * (3 - 2 * fz);
  const x00 = lerp(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), ux);
  const x10 = lerp(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), ux);
  const x01 = lerp(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), ux);
  const x11 = lerp(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), ux);
  return lerp(lerp(x00, x10, uy), lerp(x01, x11, uy), uz);
}

export function fbm3(x, y, z, octaves = 5) {
  let value = 0;
  let amplitude = 0.56;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    value += valueNoise3(x * frequency, y * frequency, z * frequency) * amplitude;
    frequency *= 2.07;
    amplitude *= 0.5;
  }
  return value;
}
