import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { createThreeCrtPass } from "../src/three-crt-pass.js";

test("the RGBA housing overlays the picture without SVG clipping or pointer interception", () => {
  const png = readFileSync(new URL("../assets/cabinet/astrabox-anime-native.png", import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 1672);
  assert.equal(png.readUInt32BE(20), 941);
  assert.equal(png[25], 6, "the frame must retain its RGBA channel");
  const css = readFileSync(new URL("../src/cabinet.css", import.meta.url), "utf8");
  const picture = css.match(/\.crt-picture\s*\{([^}]+)\}/)[1];
  const housing = css.match(/\.crt-housing\s*\{([^}]+)\}/)[1];
  assert.match(picture, /z-index:\s*0/);
  assert.match(housing, /z-index:\s*30/);
  assert.match(housing, /pointer-events:\s*none/);
  assert.doesNotMatch(css, /clip-path|data-reflections/);
  const mount = readFileSync(new URL("../src/cabinet.js", import.meta.url), "utf8");
  assert.match(mount, /src="\/assets\/cabinet\/astrabox-anime-native\.png"/);
  assert.doesNotMatch(mount, /<svg|clipPath/);
});

test("the new aperture is real alpha, covers the HUD safe area and retains the empty CSS mounting rail", () => {
  const png = readFileSync(new URL("../assets/cabinet/astrabox-anime-native.png", import.meta.url));
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), stride = width * 4;
  assert.equal(png[24], 8); assert.equal(png[25], 6); assert.equal(png[28], 0);
  const chunks = [];
  for (let p = 8; p < png.length;) {
    const size = png.readUInt32BE(p);
    if (png.toString("ascii", p + 4, p + 8) === "IDAT") chunks.push(png.subarray(p + 8, p + 8 + size));
    p += 12 + size;
  }
  const data = inflateSync(Buffer.concat(chunks)), pixels = Buffer.alloc(width * height * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = data[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, a = x >= 4 ? pixels[i - 4] : 0, b = y ? pixels[i - stride] : 0, c = y && x >= 4 ? pixels[i - stride - 4] : 0;
      const predict = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      pixels[i] = (data[y * (stride + 1) + 1 + x] + predict) & 255;
    }
  }
  const alpha = (x, y) => pixels[(Math.round(y) * width + Math.round(x)) * 4 + 3];
  assert.equal(alpha(700, 450), 0, "no opaque imitation checkerboard");
  // Preserve imagegen's native near-opaque material alpha (253/255), without
  // normalizing the source file or weakening the clear-aperture requirement.
  for (const [x, y] of [[70, 400], [1450, 200], [1450, 385], [1387, 519], [1380, 790]]) assert.ok(alpha(x, y) >= 250);
  const css = readFileSync(new URL("../src/cabinet.css", import.meta.url), "utf8");
  const content = css.match(/\.crt-content\s*\{([^}]+)\}/)[1];
  const percent = key => Number(content.match(new RegExp(`${key}:\\s*([\\d.]+)%`))[1]) / 100;
  assert.ok(Math.abs(percent("width") * width / (percent("height") * height) - 4 / 3) < .000001, "the game viewport remains 4:3");
  for (let n = 0; n <= 50; n++) {
    const u = 1 / 12 + n / 50 * (1 - 2 / 12), v = .1 + n / 50 * .8;
    for (const [x, y] of [[u, .1], [u, .9], [1 / 12, v], [11 / 12, v]]) {
      assert.ok(alpha((percent("left") + x * percent("width")) * width,
        (percent("top") + y * percent("height")) * height) <= 2, "the entire HUD perimeter must remain visible (native alpha <= 2/255)");
    }
  }
});

test("CRT retains its picture effects without a cabinet reflection texture", () => {
  const pass = createThreeCrtPass({ output: true });
  try {
    assert.deepEqual(Object.keys(pass.uniforms).sort(), ["tDiffuse", "uTime", "uTransition"]);
    assert.match(pass.material.fragmentShader, /float vignette/);
    assert.doesNotMatch(pass.material.fragmentShader, /uCabinet|cabinetReflection/);
    const pixi = readFileSync(new URL("../src/crt-filter.js", import.meta.url), "utf8");
    assert.match(pixi, /float vignette/);
    assert.doesNotMatch(pixi, /uCabinet|cabinetReflection/);
  } finally { pass.dispose(); }
});
