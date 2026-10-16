import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useAuthStore } from '@/store/useAuthStore';
import { useAffiliateStore } from '@/store/useAffiliateStore';
import { loadAffiliateOffer, type AffiliateOffer } from '@/lib/affiliateOffer';
import { getUsageOwnerKey, useUsageStore } from '@/store/useUsageStore';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';
import { describeOnboardingError } from '@/lib/onboardingErrors';
import { getAffiliateClientConfig } from '@/lib/affiliateLink';
import { TrackingPermissionStep } from './TrackingPermissionStep';

const HIGHLIGHTS: { icon: string; mdIcon: LucideIconName; label: string }[] = [
  { icon: 'cloud', mdIcon: 'Cloud', label: 'Cloud transcription with no word limit' },
  { icon: 'arrow.triangle.2.circlepath', mdIcon: 'RefreshCw', label: 'Sync notes across devices' },
  { icon: 'sparkles', mdIcon: 'Sparkles', label: 'AI cleanup, actions, and note chat' },
];

// A cold launch that resumes on this step arrives before the SDK's configure
// round trip has finished; registering then is answered immediately for a
// non-transactional placement and would skip the paywall for good. Wait this
// long for it, then present anyway so a broken SDK cannot hold the step. Only a
// confirmed free account ever waits here.
export const PAYWALL_READY_GRACE_MS = 3_000;
// How long Continue stays inert after registering: long enough for the SDK to
// actually present (or report it can't), short enough that a paywall which
// never resolves is still escapable.
export const PAYWALL_ESCAPE_MS = 8_000;

/**
 * Presents the Superwall paywall, then resumes setup whether or
 * not anything was purchased. This screen is only a backdrop — Superwall's own
 * paywall is the real surface — so its job is to never become a dead end.
 */
export function PaywallStep() {
  const { goNext } = useOnboardingStep('paywall');
  const user = useAuthStore((s) => s.user);
  const sessionCookie = useAuthStore((s) => s.sessionCookie);
  const usage = useUsageStore((s) => s.usage);
  const usageOwnerKey = useUsageStore((s) => s.ownerKey);
  // Usage is only this account's when the store loaded it for the current
  // session; an older account's usage, or none yet, says nothing about the plan.
  const isConfirmedFree =
    usage !== null &&
    usageOwnerKey !== null &&
    usageOwnerKey === getUsageOwnerKey() &&
    !usage.isSubscribed;
  const { register, state, isConfigured } = useSuperwallGate();
  // Creator preparation awaits before registering; by then the SDK may have
  // finished configuring, so register through the latest gate, not this render's.
  const registerRef = useRef(register);
  useEffect(() => {
    registerRef.current = register;
  }, [register]);
  const hasPresentedRef = useRef(false);
  const hasAdvancedRef = useRef(false);
  const unmountedRef = useRef(false);
  const registrationRef = useRef<AbortController | null>(null);
  const [readyGraceElapsed, setReadyGraceElapsed] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [escapeElapsed, setEscapeElapsed] = useState(false);
  const affiliateEnabled = Boolean(getAffiliateClientConfig());
  // Only a trusted inbound creator link brings the tracking question forward, so
  // its offer can be checked; everyone else meets it at its usual step after signup.
  const [inboundCreator, setInboundCreator] = useState<boolean | null>(
    affiliateEnabled ? null : false,
  );
  const [consentChecked, setConsentChecked] = useState(false);
  const completeConsent = useCallback(async () => setConsentChecked(true), []);
  const consentReady = inboundCreator === false || (inboundCreator === true && consentChecked);
  const userId = user?.id;
  useEffect(() => {
    if (!affiliateEnabled) return;
    let active = true;
    (async () => {
      await useAffiliateStore.getState().hydrate();
      await useAffiliateStore.getState().bindSession();
    })()
      .catch(() => {})
      .finally(() => {
        if (active) setInboundCreator(useAffiliateStore.getState().inboundOfferPending);
      });
    return () => {
      active = false;
    };
  }, [affiliateEnabled, userId]);

  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const advance = useCallback(async (): Promise<void> => {
    if (hasAdvancedRef.current) return;
    hasAdvancedRef.current = true;
    hasPresentedRef.current = true;
    registrationRef.current?.abort();
    setAdvanceError(null);
    try {
      await goNext();
    } catch (error) {
      hasAdvancedRef.current = false;
      setAdvanceError(describeOnboardingError(error, 'Could not save progress. Try again.'));
    }
  }, [goNext]);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      registrationRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (isConfigured) return;
    const timer = setTimeout(() => setReadyGraceElapsed(true), PAYWALL_READY_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isConfigured]);

  useEffect(() => {
    if (!presenting) return;
    const timer = setTimeout(() => setEscapeElapsed(true), PAYWALL_ESCAPE_MS);
    return () => clearTimeout(timer);
  }, [presenting]);

  useEffect(() => {
    // Once presented, stay presented: `register` is rebuilt whenever the gate
    // provider's inputs change, and a second registration mid-presentation is
    // answered immediately for a non-transactional placement.
    if (hasPresentedRef.current) return;

    // No session means no billing identity, so a purchase made now could not
    // be attributed to anyone and would be lost; a subscriber has nothing to
    // buy. A plan that hasn't loaded skips too rather than holding the user for
    // a usage round trip: a paid account must never see the offer, and a free
    // one still meets the usage limit and feature paywalls later.
    if (!user || !isConfirmedFree) {
      hasPresentedRef.current = true;
      setSkipping(true);
      void advance();
      return;
    }

    if (!consentReady) return;

    if (!isConfigured && !readyGraceElapsed) return;
    hasPresentedRef.current = true;
    setPresenting(true);

    // Failures are already reported by SuperwallGateProvider. Swallowing here is
    // what keeps a missing campaign, a bad API key or an SDK error from stopping
    // onboarding — the user just continues setup. Unmount is the
    // only thing that cancels the advance; effect re-runs must not.
    const controller = new AbortController();
    registrationRef.current = controller;
    const isCurrent = () =>
      !unmountedRef.current &&
      !hasAdvancedRef.current &&
      !controller.signal.aborted &&
      useAuthStore.getState().user?.id === user.id &&
      useAuthStore.getState().sessionCookie === sessionCookie;
    (async () => {
      // Only a trusted inbound-link intent can seed this first presentation.
      // Ordinary rendering and typed candidates never claim or allocate stock.
      let creatorOffer: AffiliateOffer | undefined;
      try {
        if (affiliateEnabled && (await useAffiliateStore.getState().consumeInboundOffer(isCurrent)))
          creatorOffer = (await loadAffiliateOffer(isCurrent)) ?? undefined;
      } catch {
        // Optional referral storage must not skip ordinary purchasing.
      }
      if (!isCurrent()) return;
      const latestUsage = useUsageStore.getState();
      if (
        !latestUsage.usage ||
        !latestUsage.ownerKey ||
        latestUsage.ownerKey !== getUsageOwnerKey() ||
        latestUsage.usage.isSubscribed
      ) {
        setPresenting(false);
        setSkipping(true);
        return;
      }
      await registerRef.current({
        placement: SUPERWALL_PLACEMENTS.onboardingPaywall,
        signal: controller.signal,
        creatorOffer,
      });
    })()
      .catch(() => {})
      .finally(() => {
        if (isCurrent()) void advance();
      });
  }, [
    advance,
    affiliateEnabled,
    consentReady,
    isConfigured,
    isConfirmedFree,
    readyGraceElapsed,
    user,
    sessionCookie,
  ]);

  // Between registering and the SDK presenting, this backdrop looks like an
  // ordinary screen with a primary button; tapping it would mount the next
  // step underneath a paywall that then presents on top of it.
  const ctaDisabled = !advanceError && presenting && state.status === 'idle' && !escapeElapsed;

  const errorNotice = advanceError ? (
    <Text accessibilityRole="alert" className="text-systemRed">
      {advanceError}
    </Text>
  ) : null;

  // Decided in render, not after the effect, so the Pro pitch never flashes for
  // a paid or unconfirmed account. Continue stays so a failed save can retry.
  const showsOffer = presenting || (!skipping && user !== null && isConfirmedFree);
  if (!showsOffer) {
    return (
      <OnboardingShell title="" titleNode={<View />} ctaLabel="Continue" onCta={advance}>
        {errorNotice}
      </OnboardingShell>
    );
  }

  if (inboundCreator && !consentChecked && user && isConfirmedFree)
    return <TrackingPermissionStep onComplete={completeConsent} />;

  return (
    <OnboardingShell
      title="Go further with OpenWhispr Pro."
      titleAccent="Pro"
      subtitle="Unlock more with Pro, or close the offer to keep using Cloud with your current limits."
      ctaLabel="Continue"
      ctaDisabled={ctaDisabled}
      onCta={advance}
    >
      <View className="gap-4 pt-2">
        {errorNotice}
        {HIGHLIGHTS.map((item) => (
          <View key={item.label} className="flex-row items-center gap-3">
            <SystemIcon name={item.icon} mdName={item.mdIcon} size={20} />
            <Text className="flex-1 text-[16px] text-label">{item.label}</Text>
          </View>
        ))}
      </View>
    </OnboardingShell>
  );
}
