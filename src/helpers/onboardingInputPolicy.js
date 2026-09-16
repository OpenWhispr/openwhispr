const ONBOARDING_DEMO_KINDS = new Set(["dictation", "assistant"]);
const ONBOARDING_DEMO_STATUSES = new Set([
  "preparing",
  "listening",
  "level",
  "processing",
  "partial",
  "replying",
  "success",
  "error",
  "cancelled",
]);

function isOnboardingInputAllowed(onboardingActive, demoKind, inputKind) {
  if (!onboardingActive) return true;
  return ONBOARDING_DEMO_KINDS.has(demoKind) && demoKind === inputKind;
}

module.exports = { ONBOARDING_DEMO_KINDS, ONBOARDING_DEMO_STATUSES, isOnboardingInputAllowed };
