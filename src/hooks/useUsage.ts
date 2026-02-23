import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "./useAuth";
import { CACHE_CONFIG } from "../config/constants";
import { withSessionRefresh } from "../lib/neonAuth";

interface UsageData {
  wordsUsed: number;
  wordsRemaining: number;
  limit: number;
  plan: string;
  status: string;
  isSubscribed: boolean;
  isTrial: boolean;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  billingInterval: "monthly" | "annual" | null;
  resetAt: string;
}

interface UseUsageResult {
  plan: string;
  status: string;
  isPastDue: boolean;
  wordsUsed: number;
  wordsRemaining: number;
  limit: number;
  isSubscribed: boolean;
  isTrial: boolean;
  trialDaysLeft: number | null;
  currentPeriodEnd: string | null;
  billingInterval: "monthly" | "annual" | null;
  isOverLimit: boolean;
  isApproachingLimit: boolean;
  resetAt: string | null;
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;
  checkoutLoading: boolean;
  refetch: () => Promise<void>;
  openCheckout: (plan?: "monthly" | "annual") => Promise<{ success: boolean; error?: string }>;
  openBillingPortal: () => Promise<{ success: boolean; error?: string }>;
}

const USAGE_CACHE_TTL = CACHE_CONFIG.API_KEY_TTL; // 1 hour

export function useUsage(): UseUsageResult | null {
  const { isSignedIn, isLoaded } = useAuth();
  const [data, setData] = useState<UsageData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const checkoutInFlightRef = useRef(false);
  const lastFetchRef = useRef<number>(0);

  const fetchUsage = useCallback(async () => {
    if (!window.electronAPI?.cloudUsage) return;

    setIsLoading(true);
    setError(null);

    try {
      await withSessionRefresh(async () => {
        const result = await window.electronAPI.cloudUsage();
        if (result.success) {
          setData({
            wordsUsed: result.wordsUsed ?? 0,
            wordsRemaining: result.wordsRemaining ?? 0,
            limit: result.limit ?? 2000,
            plan: result.plan ?? "free",
            status: result.status ?? "active",
            isSubscribed: result.isSubscribed ?? false,
            isTrial: result.isTrial ?? false,
            trialDaysLeft: result.trialDaysLeft ?? null,
            currentPeriodEnd: result.currentPeriodEnd ?? null,
            billingInterval: result.billingInterval ?? null,
            resetAt: result.resetAt ?? "rolling",
          });
          lastFetchRef.current = Date.now();
        } else {
          const error: any = new Error(result.error || "Failed to fetch usage");
          error.code = result.code;
          throw error;
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch usage");
    } finally {
      setIsLoading(false);
      setHasLoaded(true);
    }
  }, []);

  const pendingRefetchRef = useRef(false);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;

    const shouldFetch = Date.now() - lastFetchRef.current > USAGE_CACHE_TTL;
    if (shouldFetch) {
      fetchUsage();
    } else {
      setIsLoading(false);
      setHasLoaded(true);
    }

    const handleFocus = () => {
      if (pendingRefetchRef.current) {
        pendingRefetchRef.current = false;
        lastFetchRef.current = 0;
        fetchUsage();
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isLoaded, isSignedIn, fetchUsage]);

  const openCheckout = useCallback(
    async (plan?: "monthly" | "annual"): Promise<{ success: boolean; error?: string }> => {
      if (checkoutInFlightRef.current)
        return { success: false, error: "Checkout already in progress" };
      if (!window.electronAPI?.cloudCheckout || !window.electronAPI?.openExternal) {
        return { success: false, error: "App not ready" };
      }
      checkoutInFlightRef.current = true;
      setCheckoutLoading(true);
      try {
        const result = await window.electronAPI.cloudCheckout(plan);
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

  const openBillingPortal = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
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
      return { success: false, error: result.error || "Failed to open billing portal" };
    } finally {
      checkoutInFlightRef.current = false;
      setCheckoutLoading(false);
    }
  }, []);

  if (!isSignedIn) return null;

  const wordsUsed = data?.wordsUsed ?? 0;
  const limit = data?.limit ?? 2000;
  const isSubscribed = data?.isSubscribed ?? false;
  const status = data?.status ?? "active";
  const isPastDue = data?.plan === "pro" && status === "past_due";
  const isOverLimit = !isSubscribed && limit > 0 && wordsUsed >= limit;
  const isApproachingLimit = !isSubscribed && limit > 0 && wordsUsed >= limit * 0.8 && !isOverLimit;

  return {
    plan: data?.plan ?? "free",
    status,
    isPastDue,
    wordsUsed,
    wordsRemaining: data?.wordsRemaining ?? (limit > 0 ? limit - wordsUsed : -1),
    limit,
    isSubscribed,
    isTrial: data?.isTrial ?? false,
    trialDaysLeft: data?.trialDaysLeft ?? null,
    currentPeriodEnd: data?.currentPeriodEnd ?? null,
    billingInterval: data?.billingInterval ?? null,
    isOverLimit,
    isApproachingLimit,
    resetAt: data?.resetAt ?? null,
    isLoading,
    hasLoaded,
    error,
    checkoutLoading,
    refetch: fetchUsage,
    openCheckout,
    openBillingPortal,
  };
}
