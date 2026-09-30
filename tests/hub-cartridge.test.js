import test from "node:test";
import assert from "node:assert/strict";
import { thumbnailCameraView } from "../src/hub-cartridge.js";

test("camera starts on the hub, ends exactly on the actual thumbnail, and stays reversible", () => {
  for (const [width, height] of [[960, 720], [390, 844], [1405, 986]]) {
    const thumbnail = { x: width * .61, y: height * .26, width: width * .3, height: height * .22 };
    assert.deepEqual(thumbnailCameraView(width, height, thumbnail, 0), { x: 0, y: 0, width, height });
    const end = thumbnailCameraView(width, height, thumbnail, 1);
    for (const key of Object.keys(end)) assert.ok(Math.abs(end[key] - thumbnail[key]) < 1e-10);
    const mid = thumbnailCameraView(width, height, thumbnail, .5);
    assert.ok(mid.x > 0 && mid.x < thumbnail.x);
    assert.ok(mid.width > thumbnail.width && mid.width < width);
    assert.deepEqual(thumbnailCameraView(width, height, thumbnail, -1), thumbnailCameraView(width, height, thumbnail, 0));
    assert.deepEqual(thumbnailCameraView(width, height, thumbnail, 2), end);
  }
});
