export const ONBOARDING_SESSION_KEY = "onboardingSessionV2";
export const LEGACY_ONBOARDING_STEP_KEY = "onboardingCurrentStep";
export const ONBOARDING_FLOW_VERSION = 2;

export type OnboardingStepId =
  | "auth"
  | "permissions"
  | "languages"
  | "use-cases"
  | "dictation-hotkey"
  | "dictation-demo"
  | "assistant-hotkey"
  | "assistant-demo"
  | "notes"
  | "setup-choice"
  | "byok-dictation"
  | "byok-assistant"
  | "local-dictation"
  | "local-assistant"
  | "enterprise-dictation"
  | "enterprise-assistant";

export type OnboardingAuthPath = "account" | "guest" | null;
export type OnboardingSetupMode = "cloud" | "byok" | "local" | "enterprise" | null;

export interface OnboardingSession {
  version: typeof ONBOARDING_FLOW_VERSION;
  currentStepId: OnboardingStepId;
  history: OnboardingStepId[];
  authPath: OnboardingAuthPath;
  setupMode: OnboardingSetupMode;
  completedStepIds: OnboardingStepId[];
}

export interface OnboardingRouteContext {
  authPath: OnboardingAuthPath;
  setupMode: OnboardingSetupMode;
  agentAllowed: boolean;
}

const ACCOUNT_ROUTE: OnboardingStepId[] = [
  "auth",
  "permissions",
  "languages",
  "use-cases",
  "dictation-hotkey",
  "dictation-demo",
];

const SETUP_ROUTES: Record<Exclude<OnboardingSetupMode, null | "cloud">, OnboardingStepId[]> = {
  byok: ["byok-dictation", "byok-assistant"],
  local: ["local-dictation", "local-assistant"],
  enterprise: ["enterprise-dictation", "enterprise-assistant"],
};

const KNOWN_STEPS = new Set<OnboardingStepId>([
  "auth",
  "permissions",
  "languages",
  "use-cases",
  "dictation-hotkey",
  "dictation-demo",
  "assistant-hotkey",
  "assistant-demo",
  "notes",
  "setup-choice",
  "byok-dictation",
  "byok-assistant",
  "local-dictation",
  "local-assistant",
  "enterprise-dictation",
  "enterprise-assistant",
]);

const LEGACY_STEP_MAP: OnboardingStepId[] = [
  "auth",
  "use-cases",
  "languages",
  "permissions",
  "dictation-hotkey",
  "assistant-hotkey",
  "notes",
  "setup-choice",
];

export function createOnboardingSession(): OnboardingSession {
  return {
    version: ONBOARDING_FLOW_VERSION,
    currentStepId: "auth",
    history: [],
    authPath: null,
    setupMode: null,
    completedStepIds: [],
  };
}

export function getOnboardingRoute(context: OnboardingRouteContext): OnboardingStepId[] {
  if (context.authPath === null) return ["auth"];

  const route =
    context.authPath === "guest"
      ? (["auth", "setup-choice"] as OnboardingStepId[])
      : [
          ...ACCOUNT_ROUTE,
          ...(context.agentAllowed
            ? (["assistant-hotkey", "assistant-demo"] as OnboardingStepId[])
            : []),
          "notes" as const,
          "setup-choice" as const,
        ];

  if (context.setupMode && context.setupMode !== "cloud") {
    route.push(
      ...SETUP_ROUTES[context.setupMode].filter(
        (stepId) => context.agentAllowed || !stepId.endsWith("assistant")
      )
    );
  }

  return route;
}

export function isOnboardingStepId(value: unknown): value is OnboardingStepId {
  return typeof value === "string" && KNOWN_STEPS.has(value as OnboardingStepId);
}

export function parseOnboardingSession(value: string | null): OnboardingSession | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<OnboardingSession>;
    if (
      parsed.version !== ONBOARDING_FLOW_VERSION ||
      !isOnboardingStepId(parsed.currentStepId) ||
      !Array.isArray(parsed.history) ||
      !Array.isArray(parsed.completedStepIds)
    ) {
      return null;
    }

    const authPath = parsed.authPath;
    const setupMode = parsed.setupMode;
    if (authPath !== null && authPath !== "account" && authPath !== "guest") return null;
    if (
      setupMode !== null &&
      setupMode !== "cloud" &&
      setupMode !== "byok" &&
      setupMode !== "local" &&
      setupMode !== "enterprise"
    ) {
      return null;
    }

    return {
      version: ONBOARDING_FLOW_VERSION,
      currentStepId: parsed.currentStepId,
      history: parsed.history.filter(isOnboardingStepId),
      authPath,
      setupMode,
      completedStepIds: parsed.completedStepIds.filter(isOnboardingStepId),
    };
  } catch {
    return null;
  }
}

export function migrateLegacyOnboardingStep(value: string | null): OnboardingStepId {
  if (!value) return "auth";
  if (isOnboardingStepId(value)) return value;

  const index = Number.parseInt(value, 10);
  if (!Number.isFinite(index) || index < 0) return "auth";
  return LEGACY_STEP_MAP[Math.min(index, LEGACY_STEP_MAP.length - 1)] ?? "auth";
}

export function reconcileStepWithRoute(
  stepId: OnboardingStepId,
  route: OnboardingStepId[]
): OnboardingStepId {
  return route.includes(stepId) ? stepId : (route.at(-1) ?? "auth");
}

export function getNextOnboardingStep(
  currentStepId: OnboardingStepId,
  route: OnboardingStepId[]
): OnboardingStepId | null {
  const index = route.indexOf(currentStepId);
  return index >= 0 ? (route[index + 1] ?? null) : (route[0] ?? null);
}
