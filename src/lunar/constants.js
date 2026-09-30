import { Vector3 } from "three";

export const PALETTE = Object.freeze({
  space: 0x020509,
  horizon: 0x0a2132,
  fog: 0x0a1a28,
  accent: 0x4df2e2,
  accentWarm: 0xffb054,
  metalDark: 0x1f252d,
  metalMid: 0x39424e,
  metalLight: 0x66727f,
});

export const SUN_POSITION = new Vector3(-66, 40, -125);
export const EARTH_POSITION = new Vector3(58, -1, -122);
export const EARTH_RADIUS = 31;
export const PLATFORM_POSITION = new Vector3(-15.7, 0, -14);
export const PLATFORM_GROUND = -0.2;
export const TERRAIN_Z_NEAR = 22;
export const TERRAIN_Z_FAR = -96;
