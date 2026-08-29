import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "./useAuth";
import { withSessionRefresh } from "../lib/auth";
import {
  getUsageState,
  isPastDueUsage,
  loadUsage,
  retryUsage,
  setUsageAccount,
  subscribeUsage,
  watchForUpgrade,
  type UsageResponse,
  type UsageState,
} from "../lib/usageStore";

export interface UseUsageResult {
  /** Entitlement is only known when this is `"success"`. Gate billing UI on it. */
  status: UsageState["status"];
  isRefreshing: boolean;
  isRetrying: boolean;
  error: string | null;
  retry: () => Promise<void>;
  refetch: () => Promise<void>;
  /** `null` while the entitlement is unknown — never assume free. */
  hasPaidAccess: boolean | null;
  /**
   * `hasPaidAccess` with the unknown case resolved in the account's favour, for
   * gates where locking out a payer costs more than briefly over-granting
   * (the server stays authoritative).
   */
  hasPaidAccessOptimistic: boolean;
  plan: string;
  isPastDue: boolean;
  wordsUsed: number;
  wordsRemaining: number;
  limit: number;
  isSubscribed: boolean;
  isPersonallySubscribed: boolean;
  entitledWorkspaceIds: string[];
  isTrial: boolean;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  billingInterval: "monthly" | "annual" | null;
  isOverLimit: boolean;
  isApproachingLimit: boolean;
  resetAt: string | null;
  /** Any Stripe action — checkout, switch-plan or portal — is in flight; they share one guard. */
  checkoutLoading: boolean;
  openCheckout: (opts?: {
    plan?: "monthly" | "annual";
    tier?: "pro" | "business";
  }) => Promise<{ success: boolean; error?: string }>;
  openBillingPortal: () => Promise<{ success: boolean; error?: string; code?: string }>;
  switchPlan: (opts: {
    plan: "monthly" | "annual";
    tier: "pro" | "business";
  }) => Promise<{ success: boolean; alreadyOnPlan?: boolean; error?: string }>;
  previewSwitchPlan: (opts: { plan: "monthly" | "annual"; tier: "pro" | "business" }) => Promise<{
    success: boolean;
    immediateAmount?: number;
    currency?: string;
    currentPriceAmount?: number;
    currentInterval?: string;
    newPriceAmount?: number;
    newInterval?: string;
    nextBillingDate?: string;
    alreadyOnPlan?: boolean;
    error?: string;
  }>;
}

async function fetchUsageResponse(): Promise<UsageResponse> {
  const cloudUsage = window.electronAPI?.cloudUsage;
  if (!cloudUsage) throw new Error("App not ready");
  return withSessionRefresh(async () => {
    const result = await cloudUsage();
    if (!result.success) {
      const error: Error & { code?: string } = new Error(result.error || "Failed to fetch usage");
      error.code = result.code;
      throw error;
    }
    return result;
  });
}

export function useUsage(): UseUsageResult | null {
  const { isSignedIn, isLoaded, user } = useAuth();
  const state = useSyncExternalStore(subscribeUsage, getUsageState);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const checkoutInFlightRef = useRef(false);
  const pendingRefetchRef = useRef(false);

  const accountId = isSignedIn ? (user?.id ?? null) : null;

  useEffect(() => {
    if (!isLoaded) return;
    setUsageAccount(accountId);
  }, [isLoaded, accountId]);

  useEffect(() => {
    if (!isLoaded || !accountId) return;

    void loadUsage(fetchUsageResponse);

    const handleFocus = () => {
      if (!pendingRefetchRef.current) return;
      pendingRefetchRef.current = false;
      void loadUsage(fetchUsageResponse, { force: true });
    };
    const handleUsageChanged = () => {
      void loadUsage(fetchUsageResponse, { force: true });
    };
    const handleUpgradeSuccess = () => {
      void watchForUpgrade(fetchUsageResponse);
    };
    window.addEventListener("focus", handleFocus);
    window.addEventListener("usage-changed", handleUsageChanged);
    window.addEventListener("upgrade-success", handleUpgradeSuccess);
    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("usage-changed", handleUsageChanged);
      window.removeEventListener("upgrade-success", handleUpgradeSuccess);
    };
  }, [isLoaded, accountId]);

  const refetch = useCallback(() => loadUsage(fetchUsageResponse, { force: true }), []);
  const retry = useCallback(() => retryUsage(fetchUsageResponse), []);

  const openCheckout = useCallback(
    async (opts?: {
      plan?: "monthly" | "annual";
      tier?: "pro" | "business";
    }): Promise<{ success: boolean; error?: string }> => {
      if (checkoutInFlightRef.current)
        return { success: false, error: "Checkout already in progress" };
      if (!window.electronAPI?.cloudCheckout || !window.electronAPI?.openExternal) {
        return { success: false, error: "App not ready" };
      }
      checkoutInFlightRef.current = true;
      setCheckoutLoading(true);
      try {
        const result = await window.electronAPI.cloudCheckout(opts);
        if (result.success && result.url) {
          pendingRefetchRef.current = true;
          await window.electronAPI.openExternal(result.url);
          return { success: true };
        }
        return { success: false, error: result.error || "Failed to start checkout" };
      } finally {
        checkoutInFlightRef.current = false;
        setCheckoutLoading(false);
      }
    },
    []
  );

  const openBillingPortal = useCallback(async (): Promise<{
    success: boolean;
    error?: string;
    code?: string;
  }> => {
    if (checkoutInFlightRef.current) return { success: false, error: "Already loading" };
    if (!window.electronAPI?.cloudBillingPortal || !window.electronAPI?.openExternal) {
      return { success: false, error: "App not ready" };
    }
    checkoutInFlightRef.current = true;
    setCheckoutLoading(true);
    try {
      const result = await window.electronAPI.cloudBillingPortal();
      if (result.success && result.url) {
        pendingRefetchRef.current = true;
        await window.electronAPI.openExternal(result.url);
        return { success: true };
      }
      return {
        success: false,
        error: result.error || "Failed to open billing portal",
        code: result.code,
      };
    } finally {
      checkoutInFlightRef.current = false;
      setCheckoutLoading(false);
    }
  }, []);

  const switchPlan = useCallback(
    async (opts: {
      plan: "monthly" | "annual";
      tier: "pro" | "business";
    }): Promise<{ success: boolean; alreadyOnPlan?: boolean; error?: string }> => {
      if (checkoutInFlightRef.current) return { success: false, error: "Already loading" };
      if (!window.electronAPI?.cloudSwitchPlan) {
        return { success: false, error: "App not ready" };
      }
      checkoutInFlightRef.current = true;
      setCheckoutLoading(true);
      try {
        const result = await window.electronAPI.cloudSwitchPlan(opts);
        if (result.success) await refetch();
        return result;
      } finally {
        checkoutInFlightRef.current = false;
        setCheckoutLoading(false);
      }
    },
    [refetch]
  );

  const previewSwitchPlan = useCallback(
    async (opts: { plan: "monthly" | "annual"; tier: "pro" | "business" }) => {
      if (!window.electronAPI?.cloudPreviewSwitch) {
        return { success: false as const, error: "App not ready" };
      }
      return window.electronAPI.cloudPreviewSwitch(opts);
    },
    []
  );

  if (!isSignedIn) return null;

  const data = state.status === "success" ? state.data : null;
  const wordsUsed = data?.wordsUsed ?? 0;
  const limit = data?.limit ?? 0;
  const isSubscribed = data?.isSubscribed ?? false;
  const isTrial = data?.isTrial ?? false;
  const hasPaidAccess = data ? data.isSubscribed || data.isTrial : null;
  const isOverLimit = Boolean(data) && !isSubscribed && limit > 0 && wordsUsed >= limit;
  const isApproachingLimit =
    Boolean(data) && !isSubscribed && limit > 0 && wordsUsed >= limit * 0.8 && !isOverLimit;

  return {
    status: state.status,
    isRefreshing: state.status === "success" && state.isRefreshing,
    isRetrying: state.status === "error" && state.isRetrying,
    error: state.status === "error" ? state.error : null,
    retry,
    refetch,
    hasPaidAccess,
    hasPaidAccessOptimistic: hasPaidAccess !== false,
    plan: data?.plan ?? "free",
    isPastDue: data ? isPastDueUsage(data) : false,
    wordsUsed,
    wordsRemaining: data?.wordsRemaining ?? 0,
    limit,
    isSubscribed,
    isPersonallySubscribed: data?.entitlementSources.personal ?? false,
    entitledWorkspaceIds: data?.entitlementSources.workspaceIds ?? [],
    isTrial,
    trialDaysLeft: data?.trialDaysLeft ?? null,
    currentPeriodEnd: data?.currentPeriodEnd ?? null,
    billingInterval: data?.billingInterval ?? null,
    isOverLimit,
    isApproachingLimit,
    resetAt: data?.resetAt ?? null,
    checkoutLoading,
    openCheckout,
    openBillingPortal,
    switchPlan,
    previewSwitchPlan,
  };
}
