import test from "node:test";
import assert from "node:assert/strict";
import { getHudSafeArea } from "../src/hud-safe-area.js";
import { StartExitIndicator } from "../src/start-exit-indicator.js";

test("HUD safe area is immutable, proportional and leaves the playfield full size", () => {
  const safe = getHudSafeArea(960, 540);
  assert.deepEqual(safe, { left: 80, top: 54, right: 880, bottom: 486, width: 800, height: 432 });
  assert.ok(Object.isFrozen(safe));
  for (const [key, value] of Object.entries(getHudSafeArea(1920, 1080))) assert.equal(value, safe[key] * 2);
});

test("START indicator empties symmetrically, stays in safe area and hides on cancellation", () => {
  const safe = getHudSafeArea(960, 540);
  const gauge = new StartExitIndicator(960, safe);
  assert.equal(gauge.visible, false);
  for (const progress of [0, .25, .5, .99, 1]) {
    gauge.update(progress);
    assert.equal(gauge.visible, true);
    assert.equal(gauge.fill.scale.x, 1 - progress);
    const bounds = gauge.getBounds();
    assert.equal(bounds.x + bounds.width / 2, 480);
    assert.ok(bounds.minX >= safe.left && bounds.maxX <= safe.right && bounds.maxY <= safe.bottom);
  }
  gauge.update(null);
  assert.equal(gauge.visible, false);
  gauge.destroy({ children: true });
});
