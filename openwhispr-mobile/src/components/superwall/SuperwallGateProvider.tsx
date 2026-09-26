import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { usePlacement, useSuperwall } from 'expo-superwall';
import type { PaywallResult, PaywallSkippedReason, PaywallState } from 'expo-superwall';
import { SuperwallGateContext } from '@/hooks/useSuperwallGate';
import type {
  RegisterSuperwallGateOptions,
  SuperwallPurchaseCompletion,
} from '@/hooks/useSuperwallGate';
import { useAuthStore } from '@/store/useAuthStore';
import { requiresRealAccount } from '@/lib/accountAccess';
import { useUsageStore } from '@/store/useUsageStore';
import {
  isTransactionalSuperwallPlacement,
  SUPERWALL_PLACEMENTS,
  type SuperwallPlacement,
} from '@/lib/superwall';
import { Sentry } from '@/lib/sentry';
import { reconcileStoreBilling } from '@/lib/billingReconciliation';
import { logPaywallViewed, logSubscription } from '@/lib/appsflyer';
import { identifyRevenueCatUser, recordRevenueCatPurchase } from '@/lib/revenuecat';

type Props = {
  children: React.ReactNode;
};

type PendingGate = {
  placement: SuperwallPlacement;
  transactional: boolean;
  feature?: () => void;
  onAccessGrantedWithoutPurchase?: () => void;
  onPurchaseComplete?: (completion: SuperwallPurchaseCompletion) => void;
  featureRan: boolean;
  accessGrantedWithoutPurchaseReported: boolean;
  purchaseCompletionReported: boolean;
  terminalEventProcessed: boolean;
  closed: boolean;
  cancelled?: boolean;
  removeAbortListener?: () => void;
  resolve: (granted: boolean) => void;
};

type PlacementCallbacks = NonNullable<Parameters<typeof usePlacement>[0]>;
type NativeRegister = ReturnType<typeof usePlacement>['registerPlacement'];
type OnboardingOffer = {
  id: number;
  gate: PendingGate;
  start: (register: NativeRegister) => void;
};

function OnboardingOfferHandler({
  offer,
  callbacks,
  dismiss,
  retire,
}: {
  offer: OnboardingOffer;
  callbacks: PlacementCallbacks;
  dismiss: () => void;
  retire: (gate: PendingGate) => void;
}): null {
  const startedRef = useRef(false);
  const { gate } = offer;
  // Each offer gets its own SDK handler identity, including after an explicit
  // onboarding reset. Keep cancelled listeners until native sends a terminal event.
  const { registerPlacement } = usePlacement({
    onPresent(info) {
      if (gate.cancelled) dismiss();
      else if (!gate.closed) callbacks.onPresent?.(info);
    },
    onDismiss(info, result) {
      if (!gate.closed) callbacks.onDismiss?.(info, result);
      retire(gate);
    },
    onSkip(reason) {
      if (!gate.closed) callbacks.onSkip?.(reason);
      retire(gate);
    },
    onError(error) {
      if (!gate.closed) callbacks.onError?.(error);
      retire(gate);
    },
  });
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!gate.cancelled) offer.start(registerPlacement);
  }, [gate, offer, registerPlacement]);
  return null;
}

// Dev-only visibility into gate decisions: Sentry breadcrumbs are invisible
// without a DSN, and skips are deliberately silent in the UI.
function debugLog(message: string, data?: Record<string, unknown>): void {
  if (__DEV__) console.log(`[superwall] ${message}`, data ?? '');
}

function describePaywallResult(result: PaywallResult): string {
  if (result.type === 'purchased') return `purchased:${result.productId}`;
  return result.type;
}

function describePaywallSkip(reason: PaywallSkippedReason): string {
  if (reason.type === 'Holdout') return `Holdout:${reason.experiment.id}`;
  return reason.type;
}

function showBillingUnavailable() {
  Alert.alert(
    'Billing Unavailable',
    'Plans and billing are not available right now. Please try again later.',
  );
}

function showBillingStarting() {
  Alert.alert('Billing Starting', 'Plans and billing are still loading. Please try again shortly.');
}

function canOpenExistingBilling(placement: SuperwallPlacement): boolean {
  return (
    placement === SUPERWALL_PLACEMENTS.accountBillingOpen &&
    Boolean(useUsageStore.getState().usage?.isSubscribed)
  );
}

function runAccessGrantedWithoutPurchaseCallback(
  callback: (() => void) | undefined,
  placement: SuperwallPlacement,
): void {
  try {
    callback?.();
  } catch (error) {
    Sentry.captureException(error, {
      tags: { feature: 'superwall', operation: 'access-granted-without-purchase-callback' },
      extra: { placement },
    });
  }
}

function reportAccessGrantedWithoutPurchase(gate: PendingGate): void {
  if (gate.accessGrantedWithoutPurchaseReported) return;
  gate.accessGrantedWithoutPurchaseReported = true;
  runAccessGrantedWithoutPurchaseCallback(gate.onAccessGrantedWithoutPurchase, gate.placement);
}

function completeGate(
  gate: PendingGate,
  granted: boolean,
  runFeature: boolean,
  reportNoPurchaseAccess: boolean,
): void {
  if (granted && reportNoPurchaseAccess) reportAccessGrantedWithoutPurchase(gate);
  if (gate.closed) return;
  gate.closed = true;
  gate.removeAbortListener?.();
  gate.resolve(granted);
  if (runFeature && !gate.featureRan) {
    gate.featureRan = true;
    try {
      gate.feature?.();
    } catch (error) {
      Sentry.captureException(error, {
        tags: { feature: 'superwall', operation: 'gated-feature-callback' },
        extra: { placement: gate.placement },
      });
    }
  }
}

function reportPurchaseCompletion(
  gate: PendingGate,
  completion: SuperwallPurchaseCompletion,
): void {
  if (gate.purchaseCompletionReported) return;
  gate.purchaseCompletionReported = true;
  try {
    gate.onPurchaseComplete?.(completion);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { feature: 'superwall', operation: 'purchase-completion-callback' },
      extra: { placement: gate.placement, completion },
    });
  }
}

// Reconciliation asks the backend to ask RevenueCat, which is not guaranteed to
// have seen a Superwall-completed StoreKit 2 purchase until it is recorded.
// Identify first so the receipt posts under the billing user, not an anonymous
// id. Never rejects; the lib reports its own failures.
async function recordPurchaseForBilling(productId: string): Promise<void> {
  const billingUserId = useUsageStore.getState().usage?.billingUserId;
  if (billingUserId) await identifyRevenueCatUser(billingUserId);
  await recordRevenueCatPurchase(productId);
}

// The gate stays open while the purchase is recorded, so a hung native call must
// not leave it (and every later placement) stuck.
const PURCHASE_RECORD_TIMEOUT_MS = 10_000;

function recordPurchaseWithTimeout(productId: string): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    recordPurchaseForBilling(productId),
    new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, PURCHASE_RECORD_TIMEOUT_MS);
    }),
  ]).finally(() => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });
}

async function reconcileAfterPaywall(): Promise<void> {
  try {
    await reconcileStoreBilling();
  } catch (error) {
    Sentry.captureException(error, {
      tags: { feature: 'superwall', operation: 'store-reconciliation-after-paywall' },
    });
  }

  const loadResult = await useUsageStore.getState().load(true);
  if (loadResult.status === 'failed') {
    Sentry.captureException(loadResult.error, {
      tags: { feature: 'superwall', operation: 'usage-refresh-after-paywall' },
    });
  }
}

function useRouteToAuth(activePlacementRef: React.RefObject<SuperwallPlacement | null>) {
  const isGuest = useAuthStore((state) => state.isGuest);
  const user = useAuthStore((state) => state.user);

  return useCallback(() => {
    const placement = activePlacementRef.current;
    Sentry.addBreadcrumb({
      category: 'superwall',
      message: 'placement requires sign in',
      level: 'info',
      data: { placement, preservedGuestMode: isGuest },
    });

    // A guest or an anonymous session is already inside the app, so open the
    // auth modal over it; only a device with no session at all is sent back
    // to the root, where the auth gate renders.
    if (isGuest || user) {
      const params =
        placement === SUPERWALL_PLACEMENTS.accountBillingOpen
          ? '?returnTo=account&superwallPlacement=account_billing_open'
          : '';
      router.push(`/auth${params}`);
    } else {
      router.replace('/');
    }
  }, [activePlacementRef, isGuest, user]);
}

export function DisabledSuperwallGateProvider({ children }: Props) {
  const user = useAuthStore((state) => state.user);
  const activePlacementRef = useRef<SuperwallPlacement | null>(null);
  const routeToAuth = useRouteToAuth(activePlacementRef);

  const register = useCallback(
    async ({
      placement,
      feature,
      onAccessGrantedWithoutPurchase,
      requiresAccount = isTransactionalSuperwallPlacement(placement),
    }: RegisterSuperwallGateOptions): Promise<boolean> => {
      debugLog('register (Superwall DISABLED — no API key in this build)', { placement });
      activePlacementRef.current = placement;

      if (requiresAccount && requiresRealAccount(user)) {
        routeToAuth();
        activePlacementRef.current = null;
        return false;
      }

      if (!requiresAccount) {
        Sentry.addBreadcrumb({
          category: 'superwall',
          message: 'non-transactional placement skipped because Superwall keys are missing',
          level: 'info',
          data: { placement },
        });
        feature?.();
        runAccessGrantedWithoutPurchaseCallback(onAccessGrantedWithoutPurchase, placement);
        activePlacementRef.current = null;
        return true;
      }

      if (canOpenExistingBilling(placement)) {
        Sentry.addBreadcrumb({
          category: 'superwall',
          message: 'existing subscriber billing opened without Superwall',
          level: 'info',
          data: { placement },
        });
        feature?.();
        runAccessGrantedWithoutPurchaseCallback(onAccessGrantedWithoutPurchase, placement);
        activePlacementRef.current = null;
        return true;
      }

      Sentry.addBreadcrumb({
        category: 'superwall',
        message: 'placement skipped because Superwall keys are missing',
        level: 'info',
        data: { placement },
      });
      showBillingUnavailable();
      activePlacementRef.current = null;
      return false;
    },
    [routeToAuth, user],
  );

  const value = useMemo(
    () => ({ register, state: { status: 'idle' } as const, isConfigured: true }),
    [register],
  );

  return <SuperwallGateContext.Provider value={value}>{children}</SuperwallGateContext.Provider>;
}

export function EnabledSuperwallGateProvider({ children }: Props) {
  const user = useAuthStore((state) => state.user);
  const { isConfigured, configurationError, dismiss } = useSuperwall((state) => ({
    isConfigured: state.isConfigured,
    configurationError: state.configurationError,
    dismiss: state.dismiss,
  }));

  const activePlacementRef = useRef<SuperwallPlacement | null>(null);
  const pendingGateRef = useRef<PendingGate | null>(null);
  const presentationGatesRef = useRef<PendingGate[]>([]);
  const nextOfferId = useRef(0);
  const [onboardingOffers, setOnboardingOffers] = useState<OnboardingOffer[]>([]);
  const [onboardingState, setOnboardingState] = useState<PaywallState>({ status: 'idle' });
  const retireOffer = useCallback((gate: PendingGate): void => {
    setOnboardingOffers((offers) => offers.filter((offer) => offer.gate !== gate));
  }, []);
  const routeToAuth = useRouteToAuth(activePlacementRef);

  const finishActiveGate = useCallback(
    (granted: boolean, runFeature: boolean, reportNoPurchaseAccess: boolean) => {
      const gate = pendingGateRef.current;
      if (!gate) return;
      completeGate(gate, granted, runFeature, reportNoPurchaseAccess);
      if (pendingGateRef.current === gate) pendingGateRef.current = null;
      activePlacementRef.current = null;
    },
    [],
  );

  const finishPresentationGate = useCallback(
    (granted: boolean, runFeature: boolean, reportNoPurchaseAccess: boolean) => {
      const gate = presentationGatesRef.current.shift();
      if (!gate) return;
      gate.terminalEventProcessed = true;
      const isActiveGate = pendingGateRef.current === gate;
      completeGate(gate, granted, runFeature, reportNoPurchaseAccess);
      if (isActiveGate) {
        pendingGateRef.current = null;
        activePlacementRef.current = null;
      }
    },
    [],
  );

  const placementCallbacks: PlacementCallbacks = {
    onPresent(paywallInfo) {
      const gate = pendingGateRef.current;
      if (gate?.placement === SUPERWALL_PLACEMENTS.onboardingPaywall) {
        setOnboardingState({ status: 'presented', paywallInfo });
      }
      if (gate && !presentationGatesRef.current.includes(gate)) {
        presentationGatesRef.current.push(gate);
      }
      const placement = activePlacementRef.current;
      if (placement) logPaywallViewed(placement);
      debugLog('paywall presented', {
        placement,
        paywall: paywallInfo.name,
      });
      Sentry.addBreadcrumb({
        category: 'superwall',
        message: 'paywall presented',
        level: 'info',
        data: {
          placement,
          paywallId: paywallInfo.identifier,
          paywallName: paywallInfo.name,
        },
      });
    },
    onDismiss(_paywallInfo, result) {
      const placement = activePlacementRef.current;
      debugLog('paywall dismissed', { placement, result: describePaywallResult(result) });
      Sentry.addBreadcrumb({
        category: 'superwall',
        message: 'paywall dismissed',
        level: 'info',
        data: {
          placement,
          result: describePaywallResult(result),
        },
      });

      if (result.type === 'purchased' || result.type === 'restored') {
        const gate = presentationGatesRef.current[0];
        if (gate?.purchaseCompletionReported) return;
        if (gate) {
          reportPurchaseCompletion(gate, result.type);
          if (result.type === 'purchased') {
            logSubscription(result.productId, gate.placement);
          }
        }
        const settle = () => {
          // A duplicate terminal event may already have retired this gate; never
          // shift a later registration off the queue in its place.
          if (gate && presentationGatesRef.current[0] === gate) {
            finishPresentationGate(true, true, false);
          }
          reconcileAfterPaywall().catch((error) => {
            Sentry.captureException(error, {
              tags: { feature: 'superwall', operation: 'paywall-reconciliation' },
            });
          });
        };
        if (result.type === 'restored') {
          settle();
          return;
        }
        // Hold the gate until the purchase is recorded so consumers that reconcile
        // on grant (usage-limit recovery) query the backend after RevenueCat can
        // see the transaction. Marking the gate terminal now stops the native
        // register promise from releasing it early.
        if (gate) gate.terminalEventProcessed = true;
        recordPurchaseWithTimeout(result.productId).then(settle);
        return;
      }

      const gate = presentationGatesRef.current[0];
      const failOpen = gate ? !gate.transactional : false;
      finishPresentationGate(failOpen, failOpen, failOpen);
    },
    onSkip(reason) {
      debugLog('paywall SKIPPED', {
        placement: activePlacementRef.current,
        reason: describePaywallSkip(reason),
      });
      Sentry.addBreadcrumb({
        category: 'superwall',
        message: 'paywall skipped',
        level: 'info',
        data: {
          placement: activePlacementRef.current,
          reason: describePaywallSkip(reason),
        },
      });
      if (presentationGatesRef.current.length > 0) return;
      const gate = pendingGateRef.current;
      if (!gate) return;
      const placementMissing = reason.type === 'PlacementNotFound';
      const granted = !placementMissing || !gate.transactional;
      finishActiveGate(granted, granted, granted);
    },
    onError(error) {
      debugLog('paywall ERROR', { placement: activePlacementRef.current, error });
      const presentedGate = presentationGatesRef.current[0];
      if (presentedGate) {
        const billingFallback = canOpenExistingBilling(presentedGate.placement);
        const failOpen = !presentedGate.transactional;
        Sentry.captureException(new Error(error), {
          tags: { feature: 'superwall', operation: 'paywall' },
          extra: { placement: presentedGate.placement },
        });
        finishPresentationGate(
          failOpen || billingFallback,
          failOpen || billingFallback,
          failOpen || billingFallback,
        );
        if (presentedGate.transactional && !billingFallback) showBillingUnavailable();
        return;
      }

      const gate = pendingGateRef.current;
      if (!gate) return;
      const billingFallback = canOpenExistingBilling(gate.placement);
      const failOpen = !gate.transactional;
      Sentry.captureException(new Error(error), {
        tags: { feature: 'superwall', operation: 'paywall' },
        extra: { placement: activePlacementRef.current },
      });
      finishActiveGate(
        failOpen || billingFallback,
        failOpen || billingFallback,
        failOpen || billingFallback,
      );
      if (gate?.transactional && !billingFallback) showBillingUnavailable();
    },
  };

  const dismissCancelledOffer = useCallback((): void => {
    dismiss().catch((error: unknown) => {
      Sentry.captureException(error, {
        tags: { feature: 'superwall', operation: 'dismiss-cancelled-onboarding' },
      });
    });
  }, [dismiss]);

  const { registerPlacement, state: billingState } = usePlacement(placementCallbacks);
  const state =
    activePlacementRef.current === SUPERWALL_PLACEMENTS.onboardingPaywall
      ? onboardingState
      : billingState;

  const register = useCallback(
    async ({
      placement,
      params,
      feature,
      onAccessGrantedWithoutPurchase,
      onPurchaseComplete,
      signal,
      requiresAccount = isTransactionalSuperwallPlacement(placement),
    }: RegisterSuperwallGateOptions): Promise<boolean> => {
      const isOnboarding = placement === SUPERWALL_PLACEMENTS.onboardingPaywall;
      if (isOnboarding && signal?.aborted) return false;
      debugLog('register', {
        placement,
        requiresAccount,
        isConfigured,
        configurationError,
        signedIn: !!user,
      });
      if (pendingGateRef.current) {
        debugLog('BLOCKED: another gate is active', {
          activePlacement: pendingGateRef.current.placement,
        });
        Sentry.addBreadcrumb({
          category: 'superwall',
          message: 'placement ignored while another gate is active',
          level: 'warning',
          data: { placement, activePlacement: pendingGateRef.current.placement },
        });
        if (!requiresAccount) {
          feature?.();
          runAccessGrantedWithoutPurchaseCallback(onAccessGrantedWithoutPurchase, placement);
          return true;
        }
        return false;
      }

      activePlacementRef.current = placement;

      // An anonymous onboarding session counts as no account here: a purchase
      // from an in-app placement would have nobody to attach to.
      if (requiresAccount && requiresRealAccount(user)) {
        debugLog('routing to auth (no account)');
        routeToAuth();
        activePlacementRef.current = null;
        return false;
      }

      if (configurationError) {
        debugLog('BLOCKED by configuration error', { configurationError });
        Sentry.addBreadcrumb({
          category: 'superwall',
          message: 'placement blocked by configuration error',
          level: 'warning',
          data: { placement, configurationError },
        });
        if (!requiresAccount) {
          feature?.();
          runAccessGrantedWithoutPurchaseCallback(onAccessGrantedWithoutPurchase, placement);
          activePlacementRef.current = null;
          return true;
        }
        if (canOpenExistingBilling(placement)) {
          feature?.();
          runAccessGrantedWithoutPurchaseCallback(onAccessGrantedWithoutPurchase, placement);
          activePlacementRef.current = null;
          return true;
        }
        showBillingUnavailable();
        activePlacementRef.current = null;
        return false;
      }

      if (!isConfigured) {
        debugLog('BLOCKED: configuration still pending');
        Sentry.addBreadcrumb({
          category: 'superwall',
          message: 'placement blocked while configuration is pending',
          level: 'info',
          data: { placement },
        });
        if (!requiresAccount) {
          feature?.();
          runAccessGrantedWithoutPurchaseCallback(onAccessGrantedWithoutPurchase, placement);
          activePlacementRef.current = null;
          return true;
        }
        if (canOpenExistingBilling(placement)) {
          feature?.();
          runAccessGrantedWithoutPurchaseCallback(onAccessGrantedWithoutPurchase, placement);
          activePlacementRef.current = null;
          return true;
        }
        showBillingStarting();
        activePlacementRef.current = null;
        return false;
      }

      return new Promise<boolean>((resolve) => {
        const gate: PendingGate = {
          placement,
          transactional: isTransactionalSuperwallPlacement(placement),
          feature,
          onAccessGrantedWithoutPurchase,
          onPurchaseComplete,
          featureRan: false,
          accessGrantedWithoutPurchaseReported: false,
          purchaseCompletionReported: false,
          terminalEventProcessed: false,
          closed: false,
          resolve,
        };
        pendingGateRef.current = gate;

        if (isOnboarding && signal) {
          const cancel = (): void => {
            gate.cancelled = true;
            const wasPresented = presentationGatesRef.current.includes(gate);
            presentationGatesRef.current = presentationGatesRef.current.filter(
              (item) => item !== gate,
            );
            if (pendingGateRef.current === gate) {
              pendingGateRef.current = null;
              activePlacementRef.current = null;
            }
            completeGate(gate, false, false, false);
            if (wasPresented) dismissCancelledOffer();
          };
          signal.addEventListener('abort', cancel);
          gate.removeAbortListener = () => signal.removeEventListener('abort', cancel);
        }

        const finishGate = (
          granted: boolean,
          runFeature: boolean,
          reportNoPurchaseAccess: boolean,
        ) => {
          if (gate.terminalEventProcessed) return;
          // Only an aborted onboarding offer drops a late completion. A skipped billing placement
          // still reports access so its caller can open billing management.
          if (gate.cancelled) return;
          const isPresented = presentationGatesRef.current.includes(gate);
          if (isOnboarding && isPresented) return;
          completeGate(gate, granted, runFeature, reportNoPurchaseAccess && !isPresented);
          if (isPresented) return;
          if (pendingGateRef.current === gate) pendingGateRef.current = null;
          if (activePlacementRef.current === placement) activePlacementRef.current = null;
        };

        debugLog('registering placement with Superwall', { placement, params });
        const start = (present: NativeRegister): void => {
          present({
            placement,
            params,
            feature: () => {
              if (gate.closed) return;
              debugLog('feature gate granted', { placement });
              Sentry.addBreadcrumb({
                category: 'superwall',
                message: 'feature gate granted',
                level: 'info',
                data: { placement },
              });
              finishGate(true, true, true);
              if (isOnboarding && !presentationGatesRef.current.includes(gate) && !gate.cancelled)
                retireOffer(gate);
            },
          })
            .then(() => {
              debugLog('registerPlacement resolved (access granted)', { placement });
              finishGate(true, true, true);
            })
            .catch((error) => {
              debugLog('registerPlacement REJECTED', { placement, error: String(error) });
              if (gate.closed) return;
              Sentry.captureException(error, {
                tags: { feature: 'superwall', operation: 'register-placement' },
                extra: { placement, isConfigured },
              });
              const billingFallback = canOpenExistingBilling(placement);
              const failOpen = !gate.transactional;
              const finish =
                isOnboarding && presentationGatesRef.current.includes(gate)
                  ? finishPresentationGate
                  : finishGate;
              finish(
                failOpen || billingFallback,
                failOpen || billingFallback,
                failOpen || billingFallback,
              );
              if (gate.transactional && !billingFallback) showBillingUnavailable();
              if (isOnboarding) retireOffer(gate);
            });
        };
        if (isOnboarding) {
          setOnboardingState({ status: 'idle' });
          const offer = { id: nextOfferId.current++, gate, start };
          setOnboardingOffers((offers) => [...offers, offer]);
        } else {
          start(registerPlacement);
        }
      });
    },
    [
      configurationError,
      isConfigured,
      registerPlacement,
      dismissCancelledOffer,
      finishPresentationGate,
      retireOffer,
      routeToAuth,
      user,
    ],
  );

  const value = useMemo(() => ({ register, state, isConfigured }), [isConfigured, register, state]);

  return (
    <SuperwallGateContext.Provider value={value}>
      {children}
      {onboardingOffers.map((offer) => (
        <OnboardingOfferHandler
          key={offer.id}
          offer={offer}
          callbacks={placementCallbacks}
          dismiss={dismissCancelledOffer}
          retire={retireOffer}
        />
      ))}
    </SuperwallGateContext.Provider>
  );
}
