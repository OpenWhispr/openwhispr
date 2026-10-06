const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/ui/hotkeyCapturePolicy.ts");

test("right-side modifiers are captured on a quick release", async () => {
  const { shouldAcceptModifierOnlyCapture } = await load();

  assert.equal(shouldAcceptModifierOnlyCapture("RightOption", 0), true);
  assert.equal(shouldAcceptModifierOnlyCapture("RightControl", 50), true);
});

test("other modifier-only shortcuts retain the hold threshold", async () => {
  const { MODIFIER_ONLY_HOLD_THRESHOLD_MS, shouldAcceptModifierOnlyCapture } = await load();

  assert.equal(
    shouldAcceptModifierOnlyCapture("Control+Alt", MODIFIER_ONLY_HOLD_THRESHOLD_MS - 1),
    false
  );
  assert.equal(
    shouldAcceptModifierOnlyCapture("Control+Alt", MODIFIER_ONLY_HOLD_THRESHOLD_MS),
    true
  );
});

test("capture focus is restored only when no control owns page focus", async () => {
  const { shouldRestoreCaptureFocus } = await load();
  const body = {};
  const button = {};

  assert.equal(shouldRestoreCaptureFocus(null, body), true);
  assert.equal(shouldRestoreCaptureFocus(body, body), true);
  assert.equal(shouldRestoreCaptureFocus(button, body), false);
});
