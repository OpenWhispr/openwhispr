import { CACHE_CONFIG } from "../config/constants.ts";
import { clearIsSubscribed, writeIsSubscribed } from "./subscriptionFlag.ts";

const USAGE_ACCOUNT_KEY = "openwhispr:usageAccountId";
const USAGE_CACHE_TTL = CACHE_CONFIG.API_KEY_TTL;
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const PAID_PLANS = new Set(["pro", "business", "enterprise"]);

// Unknown tiers rank as free so a plan this build predates can't out-rank a paid one.
const PLAN_ORDER: Record<string, number> = { free: 0, pro: 1, business: 2, enterprise: 3 };

export function highestPlan(plans: string[]): string {
  return plans.reduce(
    (best, plan) => ((PLAN_ORDER[plan] ?? 0) > (PLAN_ORDER[best] ?? 0) ? plan : best),
    "free"
  );
}

export interface UsageData {
  wordsUsed: number;
  wordsRemaining: number;
  limit: number;
  plan: string;
  subscriptionStatus: string;
  isSubscribed: boolean;
  isTrial: boolean;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  billingInterval: "monthly" | "annual" | null;
  resetAt: string;
  entitlementSources: {
    personal: boolean;
    workspaceIds: string[];
  };
}

/** Raw `/api/usage` payload. Every field is optional: older API builds omit some. */
export interface UsageResponse {
  wordsUsed?: number;
  wordsRemaining?: number;
  limit?: number;
  plan?: string;
  status?: string;
  isSubscribed?: boolean;
  isTrial?: boolean;
  trialDaysLeft?: number | null;
  currentPeriodEnd?: string | null;
  billingInterval?: "monthly" | "annual" | null;
  resetAt?: string;
  entitlementSources?: {
    personal: boolean;
    workspaceIds: string[];
  };
}

/** Resolves with the payload or throws; `error.code` carries the API refusal code. */
export type UsageFetcher = () => Promise<UsageResponse>;

export type UsageState =
  | { status: "idle"; accountId: string | null }
  | { status: "loading"; accountId: string }
  | { status: "success"; accountId: string; data: UsageData; isRefreshing: boolean }
  | { status: "error"; accountId: string; error: string; code: string | null; isRetrying: boolean };

const IDLE_SIGNED_OUT: UsageState = { status: "idle", accountId: null };

let state: UsageState = IDLE_SIGNED_OUT;
let generation = 0;
let lastFetchAt = 0;
let inFlight: Promise<void> | null = null;
let retryAttempt = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let queuedForce: Promise<void> | null = null;
let upgradeWatchActive = false;
const subscribers = new Set<() => void>();

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function setState(next: UsageState): void {
  state = next;
  subscribers.forEach((subscriber) => subscriber());
}

function cancelRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

export function getUsageState(): UsageState {
  return state;
}

export function subscribeUsage(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => subscribers.delete(onChange);
}

export function normalizeUsage(response: UsageResponse): UsageData {
  const plan = response.plan ?? "free";
  const subscriptionStatus = response.status ?? "active";
  return {
    wordsUsed: response.wordsUsed ?? 0,
    wordsRemaining: response.wordsRemaining ?? 0,
    // Not the free-tier allowance: a missing limit is unknown, and meters
    // guard on `limit > 0` so they stay hidden rather than wrong.
    limit: response.limit ?? 0,
    plan,
    subscriptionStatus,
    isSubscribed: response.isSubscribed ?? false,
    isTrial: response.isTrial ?? false,
    trialDaysLeft: response.trialDaysLeft ?? null,
    currentPeriodEnd: response.currentPeriodEnd ?? null,
    billingInterval: response.billingInterval ?? null,
    resetAt: response.resetAt ?? "rolling",
    // Pre-unified-billing API builds have no entitlementSources; infer a
    // personal source from the plan so those clients keep working.
    entitlementSources: response.entitlementSources ?? {
      personal:
        response.isTrial === true ||
        (PAID_PLANS.has(plan) && ["active", "trialing"].includes(subscriptionStatus)),
      workspaceIds: [],
    },
  };
}

export function isPastDueUsage(data: UsageData): boolean {
  return PAID_PLANS.has(data.plan) && data.subscriptionStatus === "past_due";
}

export function setUsageAccount(accountId: string | null): void {
  if (state.accountId === accountId) return;

  generation += 1;
  cancelRetry();
  inFlight = null;
  queuedForce = null;
  lastFetchAt = 0;
  retryAttempt = 0;

  // The persisted flag survives only for the account that produced it: a
  // same-account relaunch keeps it for offline use; anything unattributable
  // would hand user B user A's entitlement.
  const store = storage();
  const previousAccountId = store?.getItem(USAGE_ACCOUNT_KEY) ?? null;
  if (accountId === null || previousAccountId !== accountId) clearIsSubscribed();
  if (accountId) store?.setItem(USAGE_ACCOUNT_KEY, accountId);
  else store?.removeItem(USAGE_ACCOUNT_KEY);

  setState({ status: "idle", accountId });
}

function toFailure(error: unknown): { message: string; code: string | null } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return { message: error.message, code: typeof code === "string" ? code : null };
  }
  return { message: "Failed to fetch usage", code: null };
}

function startLoad(accountId: string, fetcher: UsageFetcher): Promise<void> {
  const requestGeneration = generation;
  cancelRetry();
  setState(
    state.status === "success" ? { ...state, isRefreshing: true } : { status: "loading", accountId }
  );

  const run = (async () => {
    try {
      const response = await fetcher();
      if (requestGeneration !== generation) return;
      const data = normalizeUsage(response);
      lastFetchAt = Date.now();
      retryAttempt = 0;
      writeIsSubscribed(data.isSubscribed);
      setState({ status: "success", accountId, data, isRefreshing: false });
    } catch (error) {
      if (requestGeneration !== generation) return;
      const { message, code } = toFailure(error);
      // An expired session is resolved by the auth layer, not by retrying.
      const willRetry = code !== "AUTH_EXPIRED" && retryAttempt < RETRY_DELAYS_MS.length;
      setState({ status: "error", accountId, error: message, code, isRetrying: willRetry });
      if (willRetry) {
        const delay = RETRY_DELAYS_MS[retryAttempt];
        retryAttempt += 1;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (requestGeneration === generation) void startLoad(accountId, fetcher);
        }, delay);
      }
    } finally {
      if (requestGeneration === generation) inFlight = null;
    }
  })();

  inFlight = run;
  return run;
}

export function loadUsage(fetcher: UsageFetcher, opts: { force?: boolean } = {}): Promise<void> {
  const { accountId } = state;
  if (!accountId) return Promise.resolve();
  if (inFlight) {
    if (!opts.force) return inFlight;
    // The in-flight answer predates whatever forced the refetch; coalesce all
    // forced callers into one follow-up rather than stampeding.
    const forceGeneration = generation;
    queuedForce ??= inFlight.then(() => {
      // Clear before the check and a stale chain would wipe the follow-up the
      // *current* account queued in the meantime, costing it a duplicate fetch.
      if (forceGeneration !== generation) return;
      queuedForce = null;
      return loadUsage(fetcher, { force: true });
    });
    return queuedForce;
  }
  if (!opts.force && state.status === "success" && Date.now() - lastFetchAt < USAGE_CACHE_TTL) {
    return Promise.resolve();
  }
  return startLoad(accountId, fetcher);
}

export function retryUsage(fetcher: UsageFetcher): Promise<void> {
  retryAttempt = 0;
  return loadUsage(fetcher, { force: true });
}

/** Post-checkout poll that outlives Stripe webhook lag. */
export async function watchForUpgrade(fetcher: UsageFetcher): Promise<void> {
  if (upgradeWatchActive) return;
  upgradeWatchActive = true;
  const startGeneration = generation;
  try {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      await loadUsage(fetcher, { force: true });
      if (generation !== startGeneration) return;
      if (state.status === "success" && state.data.isSubscribed) return;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt] ?? 0));
      if (generation !== startGeneration) return;
    }
  } finally {
    upgradeWatchActive = false;
  }
}
