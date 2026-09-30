import { useCallback, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { buildUsageGateParams, SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import type { UsageLimitError } from '@/lib/usageLimitError';
import { useUsageStore, type UsageLoadResult } from '@/store/useUsageStore';
import type { UsageInfo } from '@/data/remote/usageApi';
import { reconcileStoreBilling } from '@/lib/billingReconciliation';
import { formatResetLabel } from '@/components/ui/UsageMeter';

const BILLING_REFRESH_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

type RetryWithCloud = () => Promise<void>;

function hasCloudAccess(usage: UsageInfo | null): boolean {
  return !!usage && (usage.isSubscribed || usage.wordsRemaining > 0);
}

function showUsageLimitFallback(): void {
  const usage = useUsageStore.getState().usage;
  const words =
    usage && usage.limit > 0
      ? `your ${usage.limit.toLocaleString()} free cloud words`
      : 'your free cloud words';
  const resetLabel = usage ? formatResetLabel(usage.resetAt) : '';

  Alert.alert(
    'Weekly Limit Reached',
    `You've used ${words} for this week.${resetLabel ? ` ${resetLabel}.` : ''} Switch to Private Mode for unlimited on-device dictation, or upgrade to Pro for unlimited cloud transcription.`,
    [
      { text: 'OK', style: 'cancel' },
      { text: 'View Usage', onPress: () => router.push('/(account)') },
      {
        text: 'Upgrade',
        onPress: () =>
          router.push({
            pathname: '/(account)',
            params: { superwallPlacement: SUPERWALL_PLACEMENTS.accountBillingOpen },
          }),
      },
    ],
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadFreshUsageAfterBilling(
  loadUsage: (force?: boolean) => Promise<UsageLoadResult>,
): Promise<UsageInfo | null> {
  let lastFreshUsage: UsageInfo | null = null;
  let lastError: unknown;

  for (const refreshDelay of BILLING_REFRESH_DELAYS_MS) {
    if (refreshDelay > 0) await delay(refreshDelay);
    const result = await loadUsage(true);
    if (result.status === 'loaded') {
      lastFreshUsage = result.usage;
      if (hasCloudAccess(lastFreshUsage)) return lastFreshUsage;
    } else if (result.status === 'failed') {
      lastError = result.error;
    }
  }

  if (lastError && !lastFreshUsage) {
    throw lastError;
  }
  return lastFreshUsage;
}

export function useUsageLimitRecovery() {
  const { register: registerSuperwallGate } = useSuperwallGate();
  const loadUsage = useUsageStore((state) => state.load);
  const recoveringRef = useRef(false);
  const [isRecoveringUsageLimit, setIsRecoveringUsageLimit] = useState(false);

  const handleUsageLimitReached = useCallback(
    async (error: UsageLimitError, retryWithCloud: RetryWithCloud) => {
      if (recoveringRef.current) {
        showUsageLimitFallback();
        return;
      }
      recoveringRef.current = true;
      setIsRecoveringUsageLimit(true);

      try {
        const currentUsage = useUsageStore.getState().usage;
        const gateCompleted = await registerSuperwallGate({
          placement: SUPERWALL_PLACEMENTS.cloudUsageLimitReached,
          params: currentUsage
            ? { ...buildUsageGateParams(currentUsage), source: error.source }
            : { source: error.source },
        });

        if (!gateCompleted) {
          showUsageLimitFallback();
          return;
        }

        try {
          const reconciledUsage = await reconcileStoreBilling();
          if (hasCloudAccess(reconciledUsage)) {
            await retryWithCloud();
            return;
          }
        } catch (reconciliationError) {
          console.error('[billing] Store reconciliation failed:', reconciliationError);
        }

        const refreshedUsage = await loadFreshUsageAfterBilling(loadUsage);
        if (hasCloudAccess(refreshedUsage)) {
          await retryWithCloud();
          return;
        }

        showUsageLimitFallback();
      } catch (recoveryError) {
        console.error('[billing] Usage-limit recovery failed:', recoveryError);
        showUsageLimitFallback();
      } finally {
        recoveringRef.current = false;
        setIsRecoveringUsageLimit(false);
      }
    },
    [loadUsage, registerSuperwallGate],
  );

  return { handleUsageLimitReached, isRecoveringUsageLimit };
}
