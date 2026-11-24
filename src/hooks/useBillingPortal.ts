import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/ui/useToast";
import { getValidatedAuthGeneration } from "../lib/authRequestContext";
import { billingPortalErrorCopy } from "../lib/billingPortalError";
import type { UseUsageResult } from "./useUsage";

interface UseBillingPortalReturn {
  openBillingPortal: (onReturn?: () => void) => Promise<void>;
  isOpening: boolean;
}

/**
 * Takes the caller's usage object rather than calling `useUsage` itself: the
 * in-flight guard behind `openBillingPortal` is per-instance, so a second
 * instance would let a checkout and a portal open at the same time.
 */
export function useBillingPortal(
  usage: UseUsageResult | null,
  enabled = true
): UseBillingPortalReturn {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isOpening, setIsOpening] = useState(false);

  const visit = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    visit.current = controller;
    setIsOpening(false);
    return () => {
      controller.abort();
      visit.current = null;
    };
  }, [enabled]);

  const openBillingPortal = useCallback(
    async (onReturn?: () => void): Promise<void> => {
      const signal = visit.current?.signal;
      if (!usage || !signal) return;
      const generation = getValidatedAuthGeneration();
      setIsOpening(true);
      try {
        const result: { success: boolean; code?: string } = await usage
          .openBillingPortal(onReturn, signal)
          .catch(() => ({ success: false }));
        if (result.success || signal.aborted || generation !== getValidatedAuthGeneration()) return;
        const copy = billingPortalErrorCopy(result.code);
        toast({
          title: t(copy.titleKey),
          description: t(copy.descriptionKey),
          variant: "destructive",
        });
      } finally {
        if (!signal.aborted) setIsOpening(false);
      }
    },
    [usage, toast, t]
  );

  return { openBillingPortal, isOpening: enabled && isOpening };
}
