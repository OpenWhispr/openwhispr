const ONBOARDING_DEMO_KINDS = new Set(["dictation", "assistant"]);

function isOnboardingInputAllowed(onboardingActive, demoKind, inputKind) {
  if (!onboardingActive) return true;
  const normDemo = typeof demoKind === "string" ? demoKind.trim().toLowerCase() : "";
  const normInput = typeof inputKind === "string" ? inputKind.trim().toLowerCase() : "";
  return ONBOARDING_DEMO_KINDS.has(normDemo) && normDemo === normInput;
}

module.exports = { ONBOARDING_DEMO_KINDS, isOnboardingInputAllowed };
