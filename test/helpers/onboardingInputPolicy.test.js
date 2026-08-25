const test = require("node:test");
const assert = require("node:assert/strict");
const { isOnboardingInputAllowed } = require("../../src/helpers/onboardingInputPolicy");

test("normal global inputs remain available outside onboarding", () => {
  for (const kind of ["dictation", "assistant", "translation", "agent"]) {
    assert.equal(isOnboardingInputAllowed(false, null, kind), true);
  }
});

test("onboarding blocks every global input outside a demo", () => {
  for (const kind of ["dictation", "assistant", "translation", "agent"]) {
    assert.equal(isOnboardingInputAllowed(true, null, kind), false);
  }
});

test("each onboarding demo allows only its matching recording input", () => {
  assert.equal(isOnboardingInputAllowed(true, "dictation", "dictation"), true);
  assert.equal(isOnboardingInputAllowed(true, "dictation", "assistant"), false);
  assert.equal(isOnboardingInputAllowed(true, "assistant", "assistant"), true);
  assert.equal(isOnboardingInputAllowed(true, "assistant", "dictation"), false);
  assert.equal(isOnboardingInputAllowed(true, "assistant", "translation"), false);
  assert.equal(isOnboardingInputAllowed(true, "assistant", "agent"), false);
});

test("unknown demo kinds fail closed while onboarding is active", () => {
  assert.equal(isOnboardingInputAllowed(true, "unknown", "dictation"), false);
  assert.equal(isOnboardingInputAllowed(true, undefined, "assistant"), false);
});

test("supports case-insensitive and trimmed demo and input kinds", () => {
  assert.equal(isOnboardingInputAllowed(true, "Dictation", "dictation"), true);
  assert.equal(isOnboardingInputAllowed(true, " DICTATION ", "dictation"), true);
  assert.equal(isOnboardingInputAllowed(true, "Assistant", " assistant "), true);
  assert.equal(isOnboardingInputAllowed(true, "ASSISTANT", "assistant"), true);
  assert.equal(isOnboardingInputAllowed(true, " Dictation ", "assistant"), false);
});
