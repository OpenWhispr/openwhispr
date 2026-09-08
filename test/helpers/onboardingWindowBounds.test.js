const assert = require("node:assert/strict");
const test = require("node:test");
const bounds = require("../../src/helpers/onboardingWindowBounds.js");

const { centeredBounds, clampedBounds } = bounds;

test("centers onboarding sizes around the existing window", () => {
  assert.deepEqual(
    centeredBounds(
      { x: 100, y: 100, width: 1200, height: 800 },
      { width: 480, height: 576 },
      { x: 0, y: 0, width: 1920, height: 1080 }
    ),
    { x: 460, y: 212, width: 480, height: 576 }
  );
});

test("clamps compact windows to small and negative-origin work areas", () => {
  assert.deepEqual(
    centeredBounds(
      { x: -1800, y: 50, width: 1200, height: 800 },
      { width: 480, height: 576 },
      { x: -1920, y: 0, width: 1280, height: 720 }
    ),
    { x: -1440, y: 144, width: 480, height: 576 }
  );
  assert.deepEqual(
    clampedBounds(
      { x: 5000, y: 5000, width: 1200, height: 800 },
      { x: 0, y: 0, width: 800, height: 600 }
    ),
    { x: 0, y: 0, width: 800, height: 600 }
  );
});
