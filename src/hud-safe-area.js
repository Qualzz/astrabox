// Logical coordinates, before the CRT warp and the rounded cabinet aperture.
// Keep complete HUD bounds inside this rectangle; the playfield stays full-bleed.
export function getHudSafeArea(width, height) {
  const left = width / 12;
  const top = height / 10;
  return Object.freeze({ left, top, right: width - left, bottom: height - top,
    width: width - left * 2, height: height - top * 2 });
}
