import * as THREE from "three";

// Importing this module allocates nothing; the renderer supplies its hardware limit.
export function createCanvasTextures(maxAnisotropy = 1) {
  function canvasTexture(width, height, draw) {
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = width;
    textureCanvas.height = height;
    const context = textureCanvas.getContext("2d");
    draw(context, width, height);
    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAnisotropy;
    return texture;
  }

  function radialGlowTexture(stops, size = 256) {
    return canvasTexture(size, size, (context, width, height) => {
      const gradient = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width / 2);
      for (const [offset, color] of stops) gradient.addColorStop(offset, color);
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
    });
  }

  return { canvasTexture, radialGlowTexture };
}
