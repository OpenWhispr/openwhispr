export const ONBOARDING_SESSION_KEY = "onboardingSessionV2";
export const LEGACY_ONBOARDING_STEP_KEY = "onboardingCurrentStep";
export const ONBOARDING_FLOW_VERSION = 2;

type OnboardingStorage = Pick<Storage, "setItem" | "removeItem">;

export type OnboardingStepId =
  | "auth"
  | "required-models"
  | "permissions"
  | "languages"
  | "use-cases"
  | "dictation-hotkey"
  | "activation-mode"
  | "dictation-demo"
  | "assistant-hotkey"
  | "assistant-demo"
  | "notes"
  | "setup-choice"
  | "byok-dictation"
  | "byok-assistant"
  | "local-dictation"
  | "local-assistant";

export type OnboardingAuthPath = "account" | "guest" | null;
export type OnboardingSetupMode = "cloud" | "byok" | "local" | null;

export interface OnboardingSession {
  version: typeof ONBOARDING_FLOW_VERSION;
  currentStepId: OnboardingStepId;
  history: OnboardingStepId[];
  authPath: OnboardingAuthPath;
  setupMode: OnboardingSetupMode;
  selfHostedRequested: boolean;
}

export interface OnboardingRouteContext {
  authPath: OnboardingAuthPath;
  setupMode: OnboardingSetupMode;
  agentAllowed: boolean;
  /**
   * Org-required local models are missing on disk. Inserts the blocking
   * "required-models" step right after auth — account path only, since guests
   * never fetch a policy. Callers latch this once the step is entered so a
   * mid-download policy refresh can't yank the step from under the user.
   */
  requiredModelsPending?: boolean;
  /** A confirmed Enterprise workspace is already provisioned outside onboarding. */
  skipSetupChoice?: boolean;
}

const ACCOUNT_ROUTE: OnboardingStepId[] = [
  "auth",
  "permissions",
  "languages",
  "use-cases",
  "dictation-hotkey",
  "activation-mode",
  "dictation-demo",
];

const SETUP_ROUTES: Record<Exclude<OnboardingSetupMode, null | "cloud">, OnboardingStepId[]> = {
  byok: ["byok-dictation", "byok-assistant"],
  local: ["local-dictation", "local-assistant"],
};

// Canonical flow order, independent of any one route. reconcileStepWithRoute uses
// it to clamp backwards instead of jumping to the end of the route.
const STEP_ORDER: OnboardingStepId[] = [
  "auth",
  "required-models",
  "permissions",
  "languages",
  "use-cases",
  "dictation-hotkey",
  "activation-mode",
  "dictation-demo",
  "assistant-hotkey",
  "assistant-demo",
  "notes",
  "setup-choice",
  "byok-dictation",
  "byok-assistant",
  "local-dictation",
  "local-assistant",
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
  // The old flow put permissions after these two indexes, so a save at 1-2
  // means the grants were never shown; the new route puts permissions first,
  // and resuming past it would skip the mic/accessibility prompts entirely.
  "permissions",
  "permissions",
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
    selfHostedRequested: false,
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

  const setupChoice = context.skipSetupChoice ? [] : (["setup-choice"] as OnboardingStepId[]);

  const route =
    context.authPath === "guest"
      ? // Guests still need the permission grants and a hotkey they have seen:
        // finalizeOnboarding registers dictationHotkey either way, and skipping
        // these steps shipped users who neither granted the mic nor knew their
        // trigger key.
        ([
          "auth",
          "permissions",
          "dictation-hotkey",
          "activation-mode",
          "setup-choice",
        ] as OnboardingStepId[])
      : [
          ...ACCOUNT_ROUTE,
          ...(context.agentAllowed
            ? (["assistant-hotkey", "assistant-demo"] as OnboardingStepId[])
            : []),
          "notes" as const,
          ...setupChoice,
        ];

  if (context.requiredModelsPending && context.authPath === "account") {
    route.splice(route.indexOf("auth") + 1, 0, "required-models");
  }

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
      !Array.isArray(parsed.history)
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
      setupMode !== "local"
    ) {
      return null;
    }
    if (
      parsed.selfHostedRequested !== undefined &&
      typeof parsed.selfHostedRequested !== "boolean"
    ) {
      return null;
    }

    return {
      version: ONBOARDING_FLOW_VERSION,
      currentStepId: parsed.currentStepId,
      history: parsed.history.filter(isOnboardingStepId),
      authPath,
      setupMode,
      selfHostedRequested: parsed.selfHostedRequested ?? false,
    };
  } catch {
    return null;
  }
}

/**
 * True while a persisted onboarding session sits on the blocking
 * required-models step. The background download tray uses this to keep its
 * hands off downloads that step owns: a tray row would duplicate the step's
 * own progress pill, and the tray's cancel cannot stick — the step
 * auto-restarts org-mandated downloads.
 */
export function isRequiredModelsOnboardingStepActive(sessionValue: string | null): boolean {
  return parseOnboardingSession(sessionValue)?.currentStepId === "required-models";
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
 * earlier one so nothing gets skipped — falling back to the route's last step
 * would teleport past intermediate steps (with agentAllowed false, asking for an
 * assistant step must land on its neighbour, not on setup-choice).
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
 * BYOK/local on setup-choice therefore appends two steps and the row
 * grows by two dots at that moment, which is the flow honestly getting longer.
 *
 * Returns null when there is nothing worth drawing: a compact step, an off-route
 * step, or a route with fewer than two counted steps, where a one-dot row would
 * read as decoration.
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

/** Enterprise customers keep provider/model selection in Settings, outside onboarding. */
export interface OnboardingWorkspaceEntitlement {
  id: string;
  plan?: string | null;
  status?: string | null;
}

export function isEnterpriseWorkspaceEntitled(
  workspace: Pick<OnboardingWorkspaceEntitlement, "plan" | "status"> | null | undefined
): boolean {
  return (
    workspace?.plan === "enterprise" &&
    (workspace.status === "active" || workspace.status === "trialing")
  );
}

export function resolveEnterpriseWorkspaceForOnboarding<T extends OnboardingWorkspaceEntitlement>(
  activeWorkspace: T | null | undefined,
  workspaces: T[]
): T | null {
  if (activeWorkspace) {
    return isEnterpriseWorkspaceEntitled(activeWorkspace) ? activeWorkspace : null;
  }
  return workspaces.find(isEnterpriseWorkspaceEntitled) ?? null;
}

export function shouldSkipOnboardingSetupChoice({
  isSignedIn,
  authPath,
  setupMode,
  activeWorkspace,
}: {
  isSignedIn: boolean;
  authPath: OnboardingAuthPath;
  setupMode: OnboardingSetupMode;
  activeWorkspace: Pick<OnboardingWorkspaceEntitlement, "plan" | "status"> | null | undefined;
}): boolean {
  return (
    isSignedIn &&
    authPath === "account" &&
    (setupMode === null || setupMode === "cloud") &&
    isEnterpriseWorkspaceEntitled(activeWorkspace)
  );
}
