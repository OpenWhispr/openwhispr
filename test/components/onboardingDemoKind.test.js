const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/utils/onboardingDemo.ts");

test("voice-agent recordings publish to the assistant onboarding session", async () => {
  const { getOnboardingDemoKind } = await load();

  assert.equal(getOnboardingDemoKind(true), "assistant");
  assert.equal(getOnboardingDemoKind(false), "dictation");
});
