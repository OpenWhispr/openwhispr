import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSuperwall, useSuperwallEvents, useUser } from 'expo-superwall';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import {
  buildSuperwallAttributes,
  buildSuperwallSubscriptionStatus,
  serializeSuperwallSubscriptionStatus,
} from '@/lib/superwall';
import { Sentry } from '@/lib/sentry';
import { reconcileStoreBilling } from '@/lib/billingReconciliation';

const INACTIVE_SUBSCRIPTION_STATUS = { status: 'INACTIVE' } as const;

// Dev-only visibility into identity/attribute sync: Sentry breadcrumbs are
// invisible without a DSN, and audience rules silently fail without attributes.
function debugLog(message: string, data?: Record<string, unknown>): void {
  if (__DEV__) console.log(`[superwall-bridge] ${message}`, data ?? '');
}

export function SuperwallEntitlementBridge() {
  const authUser = useAuthStore((state) => state.user);
  const isGuest = useAuthStore((state) => state.isGuest);
  const isInitialized = useAuthStore((state) => state.isInitialized);
  const usage = useUsageStore((state) => state.usage);
  const loadUsage = useUsageStore((state) => state.load);
  const activeMode = useProcessingModeStore((state) => state.activeMode);

  const { isConfigured, configurationError } = useSuperwall((state) => ({
    isConfigured: state.isConfigured,
    configurationError: state.configurationError,
  }));
  const { identify, update, signOut, setSubscriptionStatus, user: superwallUser } = useUser();

  const identifiedUserIdRef = useRef<string | null>(null);
  const subscriptionSignatureRef = useRef<string | null>(null);
  const attributeSignatureRef = useRef<string | null>(null);
  const reconciledBillingUserIdRef = useRef<string | null>(null);

  const reportError = useCallback((operation: string, error: unknown) => {
    Sentry.captureException(error, {
      tags: { feature: 'superwall', operation },
    });
  }, []);

  const refreshUsage = useCallback(
    async (operation: string, force = true) => {
      const result = await useUsageStore.getState().load(force);
      if (result.status === 'failed') {
        reportError(operation, result.error);
      }
    },
    [reportError],
  );

  useSuperwallEvents({
    onSuperwallEvent(eventInfo) {
      if (eventInfo.event.event !== 'transactionFail') return;
      reportError('transaction-failed', new Error(eventInfo.event.error));
    },
    onSubscriptionStatusChange(status) {
      Sentry.addBreadcrumb({
        category: 'superwall',
        message: 'subscription status changed',
        level: 'info',
        data: { status: status.status },
      });
      if (status.status !== 'UNKNOWN') {
        refreshUsage('usage-refresh-after-subscription-event').catch((error) => {
          reportError('usage-refresh-after-subscription-event', error);
        });
      }
    },
  });

  useEffect(() => {
    if (!isInitialized || !authUser || isGuest) return;
    loadUsage(true).then((result) => {
      if (result.status === 'failed') reportError('usage-load-after-auth', result.error);
    });
  }, [authUser, isGuest, isInitialized, loadUsage, reportError]);

  useEffect(() => {
    const billingUserId = usage?.billingUserId;
    if (!authUser || isGuest || !billingUserId) return;
    if (reconciledBillingUserIdRef.current === billingUserId) return;
    reconciledBillingUserIdRef.current = billingUserId;

    reconcileStoreBilling()
      .then(() => refreshUsage('usage-refresh-after-store-reconciliation'))
      .catch((error) => {
        // Keep the backend/webhook source usable when RevenueCat is not
        // configured or temporarily unavailable, and retry next app mount.
        reconciledBillingUserIdRef.current = null;
        reportError('authenticated-store-reconciliation', error);
      });
  }, [authUser, isGuest, refreshUsage, reportError, usage?.billingUserId]);

  useEffect(() => {
    if (!isInitialized || !isConfigured || configurationError) return;

    let cancelled = false;
    async function syncIdentity() {
      if (authUser && !isGuest) {
        // Usage lives only in memory, so a cold start briefly has authUser
        // without billingUserId. Wait for it rather than falling through to
        // signOut — resetting here would churn the persisted Superwall
        // identity (and its paywall assignments) on every launch.
        const billingUserId = usage?.billingUserId;
        if (!billingUserId) {
          debugLog('waiting for billingUserId from /api/usage before identifying');
          return;
        }
        if (
          superwallUser?.appUserId === billingUserId ||
          identifiedUserIdRef.current === billingUserId
        ) {
          return;
        }
        await identify(billingUserId, { restorePaywallAssignments: true });
        debugLog('identified with Superwall', { billingUserId });
        if (!cancelled) identifiedUserIdRef.current = billingUserId;
        return;
      }

      if (superwallUser?.appUserId || identifiedUserIdRef.current) {
        debugLog('signing out Superwall identity (app user signed out)');
        await signOut();
        if (!cancelled) {
          identifiedUserIdRef.current = null;
          subscriptionSignatureRef.current = null;
          attributeSignatureRef.current = null;
        }
      }
    }

    syncIdentity().catch((error) => reportError('identity-sync', error));
    return () => {
      cancelled = true;
    };
  }, [
    authUser,
    configurationError,
    identify,
    isConfigured,
    isGuest,
    isInitialized,
    reportError,
    signOut,
    superwallUser?.appUserId,
    usage?.billingUserId,
  ]);

  useEffect(() => {
    if (!isInitialized || !isConfigured || configurationError || authUser) return;
    if (superwallUser?.appUserId || identifiedUserIdRef.current) return;

    let cancelled = false;
    async function syncAnonymousInactiveStatus() {
      const subscriptionSignature = serializeSuperwallSubscriptionStatus(
        INACTIVE_SUBSCRIPTION_STATUS,
      );
      if (subscriptionSignatureRef.current === subscriptionSignature) return;
      await setSubscriptionStatus(INACTIVE_SUBSCRIPTION_STATUS);
      if (!cancelled) subscriptionSignatureRef.current = subscriptionSignature;
    }

    syncAnonymousInactiveStatus().catch((error) =>
      reportError('anonymous-inactive-subscription-sync', error),
    );

    return () => {
      cancelled = true;
    };
  }, [
    authUser,
    configurationError,
    isConfigured,
    isInitialized,
    reportError,
    setSubscriptionStatus,
    superwallUser?.appUserId,
  ]);

  const desiredSubscriptionStatus = useMemo(() => {
    if (!usage) return null;
    return buildSuperwallSubscriptionStatus(usage);
  }, [usage]);

  const desiredAttributes = useMemo(() => {
    if (!usage) return null;
    return buildSuperwallAttributes({ usage, activeMode });
  }, [activeMode, usage]);

  useEffect(() => {
    if (!isConfigured || configurationError || !authUser || isGuest || !usage) return;
    if (!desiredSubscriptionStatus || !desiredAttributes) return;
    const billingUserId = usage.billingUserId;
    if (
      superwallUser?.appUserId !== billingUserId &&
      identifiedUserIdRef.current !== billingUserId
    ) {
      return;
    }

    let cancelled = false;
    const backendStatus = desiredSubscriptionStatus;
    const attributes = desiredAttributes;

    async function syncEntitlementsAndAttributes() {
      // The API is authoritative. Superwall's getEntitlements() reflects status
      // injected by setSubscriptionStatus(), so feeding it back here would make
      // an expired web/Stripe subscription permanently sticky on the device.
      // Record each signature immediately after its push succeeds, before any
      // cancellation check. A push refreshes the SDK's user object, which
      // re-renders, hands out a new `update` identity, and cancels this run —
      // checking `cancelled` first meant the completed push was never
      // recorded, so the re-run pushed again, forever.
      const subscriptionSignature = serializeSuperwallSubscriptionStatus(backendStatus);
      if (subscriptionSignatureRef.current !== subscriptionSignature) {
        await setSubscriptionStatus(backendStatus);
        subscriptionSignatureRef.current = subscriptionSignature;
        debugLog('subscription status pushed', { status: subscriptionSignature });
        if (cancelled) return;
      }

      const attributeSignature = JSON.stringify(attributes);
      if (attributeSignatureRef.current !== attributeSignature) {
        await update(attributes);
        attributeSignatureRef.current = attributeSignature;
        debugLog('attributes pushed', attributes);
      }
    }

    syncEntitlementsAndAttributes().catch((error) =>
      reportError('entitlement-attribute-sync', error),
    );

    return () => {
      cancelled = true;
    };
  }, [
    authUser,
    configurationError,
    desiredAttributes,
    desiredSubscriptionStatus,
    isConfigured,
    isGuest,
    reportError,
    setSubscriptionStatus,
    superwallUser?.appUserId,
    update,
    usage,
  ]);

  return null;
}
