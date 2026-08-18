import {
  ONBOARDING_FLOW_VERSION,
  ONBOARDING_SESSION_KEY,
  LEGACY_ONBOARDING_STEP_KEY,
  type OnboardingAuthPath,
  type OnboardingSetupMode,
  type OnboardingStepId,
} from "../components/onboarding/flow";

interface DevStep {
  id: OnboardingStepId;
  label: string;
  authPath: OnboardingAuthPath;
  setupMode: OnboardingSetupMode;
}

// Jumping to a step is not just "set currentStepId". OnboardingFlow runs the id
// through reconcileStepWithRoute(), and getOnboardingRoute() only includes a
// step when authPath/setupMode put it on the route — so an unreachable id gets
// silently clamped to the nearest valid one and you land somewhere else. Every
// entry below carries the authPath/setupMode that actually make it reachable.
export const DEV_STEPS: DevStep[] = [
  { id: "auth", label: "1 · Auth", authPath: null, setupMode: null },
  { id: "permissions", label: "2 · Permissions", authPath: "account", setupMode: null },
  { id: "languages", label: "3 · Languages", authPath: "account", setupMode: null },
  { id: "use-cases", label: "4 · Use cases", authPath: "account", setupMode: null },
  { id: "dictation-hotkey", label: "5 · Dictation hotkey", authPath: "account", setupMode: null },
  { id: "dictation-demo", label: "6 · Dictation demo", authPath: "account", setupMode: null },
  { id: "assistant-hotkey", label: "7 · Assistant hotkey", authPath: "account", setupMode: null },
  { id: "assistant-demo", label: "8 · Assistant demo", authPath: "account", setupMode: null },
  { id: "notes", label: "9 · Notes", authPath: "account", setupMode: null },
  { id: "setup-choice", label: "10 · Setup choice", authPath: "account", setupMode: null },
  { id: "byok-dictation", label: "11 · BYOK dictation", authPath: "account", setupMode: "byok" },
  { id: "byok-assistant", label: "12 · BYOK assistant", authPath: "account", setupMode: "byok" },
  { id: "local-dictation", label: "13 · Local dictation", authPath: "account", setupMode: "local" },
  { id: "local-assistant", label: "14 · Local assistant", authPath: "account", setupMode: "local" },
  {
    id: "enterprise-dictation",
    label: "15 · Enterprise dictation",
    authPath: "account",
    setupMode: "enterprise",
  },
  {
    id: "enterprise-assistant",
    label: "16 · Enterprise assistant",
    authPath: "account",
    setupMode: "enterprise",
  },
];

export const DEV_STEP_OPTIONS = DEV_STEPS.map((step) => ({
  value: step.id,
  label: step.label,
}));

function findStep(stepId: string): DevStep | undefined {
  return DEV_STEPS.find((step) => step.id === stepId);
}

/**
 * Write a coherent session for `stepId` and reload so OnboardingFlow picks it up
 * from localStorage on mount. Reload (rather than poking React state) keeps this
 * entirely outside the production components.
 */
export function jumpToStep(stepId: string): void {
  const step = findStep(stepId);
  if (!step) return;

  // Everything before the target counts as history so Back stays usable.
  const priorIds = DEV_STEPS.slice(
    0,
    DEV_STEPS.findIndex((item) => item.id === step.id)
  ).map((item) => item.id);

  localStorage.setItem(
    ONBOARDING_SESSION_KEY,
    JSON.stringify({
      version: ONBOARDING_FLOW_VERSION,
      currentStepId: step.id,
      history: priorIds,
      authPath: step.authPath,
      setupMode: step.setupMode,
      completedStepIds: priorIds,
    })
  );
  localStorage.setItem(LEGACY_ONBOARDING_STEP_KEY, step.id);
  localStorage.removeItem("onboardingCompleted");
  window.location.reload();
}

/** Back to a clean first run, matching resetOnboardingProgress(). */
export function restartOnboarding(): void {
  localStorage.removeItem(ONBOARDING_SESSION_KEY);
  localStorage.removeItem("onboardingCompleted");
  localStorage.removeItem("authenticationSkipped");
  localStorage.removeItem("skipAuth");
  // AppRouter treats a signed-in user with no completion flag and no in-progress
  // marker as "returning" and re-completes onboarding behind your back. The "0"
  // is what keeps that shortcut from swallowing the reset.
  localStorage.setItem(LEGACY_ONBOARDING_STEP_KEY, "0");
  window.location.reload();
}

/** Skip onboarding entirely and land in the normal control panel. */
export function exitOnboarding(): void {
  localStorage.setItem("onboardingCompleted", "true");
  localStorage.removeItem(ONBOARDING_SESSION_KEY);
  localStorage.removeItem(LEGACY_ONBOARDING_STEP_KEY);
  window.location.reload();
}

export function currentStepId(): string {
  return localStorage.getItem(LEGACY_ONBOARDING_STEP_KEY) ?? "auth";
}
