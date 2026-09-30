import test from "node:test";
import assert from "node:assert/strict";
import { cartridgeDisplayLayout } from "../src/cartridge-display.js";

for (const [width, height] of [[1405, 986], [937, 658], [390, 844], [1920, 1080]]) {
  test(`tube ${width}x${height} is completely filled without cropping the logical playfield`, () => {
    const layout = cartridgeDisplayLayout(width, height, 960, 540);
    assert.ok(layout.width <= 960 && layout.height <= 720);
    assert.ok(Math.abs(layout.width / layout.height - width / height) < .01);
    assert.ok(Math.abs(960 * layout.scaleX - layout.width) < 1e-10);
    assert.ok(Math.abs(540 * layout.scaleY - layout.height) < 1e-10);
    assert.ok(layout.scaleX > 0 && layout.scaleY > 0);
  });
}
