import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "../components/ui/useToast";
import { billingPortalErrorCopy } from "../lib/billingPortalError";
import type { UseUsageResult } from "./useUsage";

interface UseBillingPortalReturn {
  openBillingPortal: () => Promise<void>;
  isOpening: boolean;
}

/**
 * Takes the caller's usage object rather than calling `useUsage` itself: the
 * in-flight guard behind `openBillingPortal` is per-instance, so a second
 * instance would let a checkout and a portal open at the same time.
 */
export function useBillingPortal(usage: UseUsageResult | null): UseBillingPortalReturn {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [isOpening, setIsOpening] = useState(false);

  const openBillingPortal = useCallback(async () => {
    if (!usage) return;
    setIsOpening(true);
    try {
      const result: { success: boolean; code?: string } = await usage
        .openBillingPortal()
        .catch(() => ({ success: false }));
      if (result.success) return;
      const copy = billingPortalErrorCopy(result.code);
      toast({
        title: t(copy.titleKey),
        description: t(copy.descriptionKey),
        variant: "destructive",
      });
    } finally {
      setIsOpening(false);
    }
  }, [usage, toast, t]);

  return { openBillingPortal, isOpening };
}
