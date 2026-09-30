import * as THREE from "three";
import { SUN_POSITION } from "./constants.js";

function createSunRaysTexture(canvasTexture) {
  return canvasTexture(512, 512, (context, width, height) => {
    const centerX = width / 2;
    const centerY = height / 2;
    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(centerX, centerY);
    for (let ray = 0; ray < 12; ray += 1) {
      const long = ray % 3 === 0;
      const length = long ? 236 : 150;
      const halfWidth = long ? 5 : 3;
      const gradient = context.createLinearGradient(0, -20, 0, -length);
      gradient.addColorStop(0, "rgba(255,240,170,0.7)");
      gradient.addColorStop(0.35, "rgba(255,214,110,0.22)");
      gradient.addColorStop(1, "rgba(255,190,80,0)");
      context.fillStyle = gradient;
      context.beginPath();
      context.moveTo(-halfWidth, -18);
      context.lineTo(0, -length);
      context.lineTo(halfWidth, -18);
      context.closePath();
      context.fill();
      context.rotate(Math.PI / 6);
    }
    context.restore();
  });
}

export function createSun({ canvasTexture, radialGlowTexture }) {
  const sun = new THREE.Group();
  sun.name = "sun-system";
  sun.position.copy(SUN_POSITION);

  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.7, 2),
    new THREE.MeshBasicMaterial({ color: 0xfff8dc, fog: false }),
  );
  core.name = "sun-core";

  const spriteMaterial = (map, opacity, color = 0xffffff) => new THREE.SpriteMaterial({
    map,
    transparent: true,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    opacity,
    color,
  });

  const innerGlow = new THREE.Sprite(spriteMaterial(radialGlowTexture([
    [0, "rgba(255,252,230,1)"],
    [0.12, "rgba(255,240,170,0.95)"],
    [0.3, "rgba(255,210,100,0.35)"],
    [1, "rgba(255,180,60,0)"],
  ]), 0.95));
  innerGlow.scale.setScalar(18);

  const outerGlow = new THREE.Sprite(spriteMaterial(radialGlowTexture([
    [0, "rgba(255,210,130,0.6)"],
    [0.3, "rgba(255,170,80,0.22)"],
    [0.65, "rgba(255,140,60,0.06)"],
    [1, "rgba(255,120,40,0)"],
  ]), 0.42));
  outerGlow.scale.setScalar(64);

  const rays = new THREE.Sprite(spriteMaterial(createSunRaysTexture(canvasTexture), 0.55));
  rays.name = "sun-rays";
  rays.scale.setScalar(34);

  const streak = new THREE.Sprite(spriteMaterial(canvasTexture(512, 32, (context, width, height) => {
    const gradient = context.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, "rgba(255,200,120,0)");
    gradient.addColorStop(0.5, "rgba(255,230,180,0.85)");
    gradient.addColorStop(1, "rgba(255,200,120,0)");
    context.fillStyle = gradient;
    context.fillRect(0, height * 0.42, width, height * 0.16);
    const soft = context.createLinearGradient(0, 0, width, 0);
    soft.addColorStop(0, "rgba(255,190,110,0)");
    soft.addColorStop(0.5, "rgba(255,200,140,0.3)");
    soft.addColorStop(1, "rgba(255,190,110,0)");
    context.fillStyle = soft;
    context.fillRect(0, 0, width, height);
  }), 0.3));
  streak.scale.set(52, 2.6, 1);

  sun.add(outerGlow, rays, streak, innerGlow, core);
  sun.userData.rays = rays;
  return sun;
}
