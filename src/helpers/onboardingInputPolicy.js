const ONBOARDING_DEMO_KINDS = new Set(["dictation", "assistant"]);

function isOnboardingInputAllowed(onboardingActive, demoKind, inputKind) {
  if (!onboardingActive) return true;
  return ONBOARDING_DEMO_KINDS.has(demoKind) && demoKind === inputKind;
}

module.exports = { ONBOARDING_DEMO_KINDS, isOnboardingInputAllowed };
