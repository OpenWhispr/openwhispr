const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/accessibilityPromptPolicy.js");

test("a macOS install that has never asked is prompted, so the row gets created", async () => {
  const { shouldPromptForAccessibility } = await load();
  assert.equal(
    shouldPromptForAccessibility({
      platform: "darwin",
      alreadyGranted: false,
      hasPromptedBefore: false,
    }),
    true
  );
});

test("the prompt is one-shot — a second attempt goes straight to System Settings", async () => {
  const { shouldPromptForAccessibility } = await load();
  // The macOS TCC dialog cannot be dismissed programmatically, so re-prompting
  // on every attempt would be worse than the dead end it fixes.
  assert.equal(
    shouldPromptForAccessibility({
      platform: "darwin",
      alreadyGranted: false,
      hasPromptedBefore: true,
    }),
    false
  );
});

test("an already-granted install is never prompted", async () => {
  const { shouldPromptForAccessibility } = await load();
  assert.equal(
    shouldPromptForAccessibility({
      platform: "darwin",
      alreadyGranted: true,
      hasPromptedBefore: false,
    }),
    false
  );
});

test("no prompt off macOS, where there is no Accessibility permission", async () => {
  const { shouldPromptForAccessibility } = await load();
  for (const platform of ["win32", "linux"]) {
    assert.equal(
      shouldPromptForAccessibility({
        platform,
        alreadyGranted: false,
        hasPromptedBefore: false,
      }),
      false
    );
  }
});
