import type { EnterpriseTranscriptionNeed } from "./enterpriseTranscription";

export const ONBOARDING_SESSION_KEY = "onboardingSessionV2";
export const LEGACY_ONBOARDING_STEP_KEY = "onboardingCurrentStep";
export const ONBOARDING_FLOW_VERSION = 2;

type OnboardingStorage = Pick<Storage, "setItem" | "removeItem">;

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
  /**
   * Which transcription step the enterprise route needs (see
   * enterpriseTranscription.ts). Enterprise setup only covers the LLM scopes,
   * so when policy disallows the OpenWhispr cloud the route borrows the
   * matching transcription step from the byok/local routes.
   */
  enterpriseTranscription?: EnterpriseTranscriptionNeed;
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

// Canonical flow order, independent of any one route. reconcileStepWithRoute uses
// it to clamp backwards instead of jumping to the end of the route.
const STEP_ORDER: OnboardingStepId[] = [
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
];

const KNOWN_STEPS = new Set<OnboardingStepId>(STEP_ORDER);

/**
 * Steps that render in the compact frame. That frame has no footer, so these
 * steps show no progress row and are left out of the count entirely — landing on
 * `languages` reads as "1 of N", not "3 of N" for two steps the user never saw a
 * counter on.
 */
export const COMPACT_STEPS: ReadonlySet<OnboardingStepId> = new Set<OnboardingStepId>([
  "auth",
  "permissions",
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

export function resetOnboardingProgress(storage: OnboardingStorage): void {
  storage.removeItem(ONBOARDING_SESSION_KEY);
  storage.removeItem("onboardingCompleted");
  storage.removeItem("authenticationSkipped");
  storage.removeItem("skipAuth");
  // AppRouter uses this marker to distinguish an explicit restart from a
  // returning signed-in user, while useOnboardingSession migrates it to auth.
  storage.setItem(LEGACY_ONBOARDING_STEP_KEY, "0");
}

export function getOnboardingRoute(context: OnboardingRouteContext): OnboardingStepId[] {
  if (context.authPath === null) return ["auth"];

  const route =
    context.authPath === "guest"
      ? // Guests still need the permission grants and a hotkey they have seen:
        // finalizeOnboarding registers dictationHotkey either way, and skipping
        // these steps shipped users who neither granted the mic nor knew their
        // trigger key.
        (["auth", "permissions", "dictation-hotkey", "setup-choice"] as OnboardingStepId[])
      : [
          ...ACCOUNT_ROUTE,
          ...(context.agentAllowed
            ? (["assistant-hotkey", "assistant-demo"] as OnboardingStepId[])
            : []),
          "notes" as const,
          "setup-choice" as const,
        ];

  if (context.setupMode && context.setupMode !== "cloud") {
    if (context.setupMode === "enterprise") {
      const need = context.enterpriseTranscription ?? "none";
      // The self-hosted variant renders inside the byok step ("custom"
      // provider form), so both borrow byok-dictation.
      if (need === "byok" || need === "self-hosted") route.push("byok-dictation");
      else if (need === "local") route.push("local-dictation");
    }
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

/**
 * Map a step onto the caller's route, for when a saved session names a step the
 * current route no longer has (the agent gets disallowed, setupMode changes, or a
 * dev jump asks for an off-route step).
 *
 * Clamps to the route step nearest in the canonical order, ties going to the
 * earlier one so nothing gets skipped. route.at(-1) was the old fallback and it
 * teleported you to the LAST step: with agentAllowed false, asking for either
 * assistant step landed on setup-choice, jumping past notes and reading as
 * "onboarding sent me straight to the plan chooser". Nearest-wins keeps the guest
 * route's assistant-demo -> setup-choice (distance 2 vs auth's 7) while the
 * account route lands on its neighbour instead of the end.
 */
export function reconcileStepWithRoute(
  stepId: OnboardingStepId,
  route: OnboardingStepId[]
): OnboardingStepId {
  if (route.includes(stepId)) return stepId;
  const target = STEP_ORDER.indexOf(stepId);
  if (target === -1 || route.length === 0) return route[0] ?? "auth";
  return route.reduce((best, candidate) => {
    const bestDistance = Math.abs(STEP_ORDER.indexOf(best) - target);
    const candidateDistance = Math.abs(STEP_ORDER.indexOf(candidate) - target);
    return candidateDistance < bestDistance ? candidate : best;
  }, route[0]);
}

export function getNextOnboardingStep(
  currentStepId: OnboardingStepId,
  route: OnboardingStepId[]
): OnboardingStepId | null {
  const index = route.indexOf(currentStepId);
  return index >= 0 ? (route[index + 1] ?? null) : (route[0] ?? null);
}

export interface OnboardingProgressState {
  /** Zero-based position among the counted steps. */
  index: number;
  /** Number of counted steps in the current route. */
  total: number;
}

/**
 * Progress across the live route: one dot per step the user will actually see a
 * counter on, filled up to the current one.
 *
 * The total comes from the route rather than a constant because the route itself
 * is conditional — the assistant pair drops out when the agent is disallowed, and
 * the provider pair only exists once a non-cloud setup mode is picked. Choosing
 * BYOK/local/enterprise on setup-choice therefore appends two steps and the row
 * grows by two dots at that moment, which is the flow honestly getting longer.
 *
 * Returns null when there is nothing worth drawing: a compact step, an off-route
 * step, or a route so short (the guest path is setup-choice alone) that a
 * one-dot row would read as decoration.
 */
export function getOnboardingProgress(
  stepId: OnboardingStepId,
  route: OnboardingStepId[]
): OnboardingProgressState | null {
  if (COMPACT_STEPS.has(stepId)) return null;

  const counted = route.filter((candidate) => !COMPACT_STEPS.has(candidate));
  const index = counted.indexOf(stepId);
  if (index === -1 || counted.length < 2) return null;

  return { index, total: counted.length };
}
