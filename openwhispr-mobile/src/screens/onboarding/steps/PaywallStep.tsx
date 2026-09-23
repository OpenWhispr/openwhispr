import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { useSuperwallGate } from '@/hooks/useSuperwallGate';
import { SUPERWALL_PLACEMENTS } from '@/lib/superwall';

const HIGHLIGHTS: { icon: string; mdIcon: LucideIconName; label: string }[] = [
  { icon: 'cloud', mdIcon: 'Cloud', label: 'Cloud transcription with no word limit' },
  { icon: 'arrow.triangle.2.circlepath', mdIcon: 'RefreshCw', label: 'Sync notes across devices' },
  { icon: 'sparkles', mdIcon: 'Sparkles', label: 'AI cleanup, actions, and note chat' },
];

// A cold launch that resumes on this step arrives before the SDK's configure
// round trip has finished; registering then is answered immediately for a
// non-transactional placement and would skip the paywall for good. Wait this
// long for it, then present anyway so a broken SDK cannot hold the step.
export const PAYWALL_READY_GRACE_MS = 3_000;
// How long Continue stays inert after registering: long enough for the SDK to
// actually present (or report it can't), short enough that a paywall which
// never resolves is still escapable.
export const PAYWALL_ESCAPE_MS = 8_000;

/**
 * Presents the Superwall paywall, then hands off to the account step whether or
 * not anything was purchased. This screen is only a backdrop — Superwall's own
 * paywall is the real surface — so its job is to never become a dead end.
 */
export function PaywallStep() {
  const goNext = useOnboardingStore((s) => s.goNext);
  const user = useAuthStore((s) => s.user);
  const isSubscribed = useUsageStore((s) => s.usage?.isSubscribed ?? false);
  const { register, state, isConfigured } = useSuperwallGate();
  const hasPresentedRef = useRef(false);
  const hasAdvancedRef = useRef(false);
  const unmountedRef = useRef(false);
  const [readyGraceElapsed, setReadyGraceElapsed] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [escapeElapsed, setEscapeElapsed] = useState(false);

  const advance = useCallback(() => {
    if (hasAdvancedRef.current) return;
    hasAdvancedRef.current = true;
    goNext();
  }, [goNext]);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
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
    // buy. Either way there is no paywall worth presenting.
    if (!user || isSubscribed) {
      hasPresentedRef.current = true;
      advance();
      return;
    }

    if (!isConfigured && !readyGraceElapsed) return;
    hasPresentedRef.current = true;
    setPresenting(true);

    // Failures are already reported by SuperwallGateProvider. Swallowing here is
    // what keeps a missing campaign, a bad API key or an SDK error from stopping
    // onboarding — the user just continues to the account step. Unmount is the
    // only thing that cancels the advance; effect re-runs must not.
    register({ placement: SUPERWALL_PLACEMENTS.onboardingPaywall })
      .catch(() => {})
      .finally(() => {
        if (!unmountedRef.current) advance();
      });
  }, [advance, isConfigured, isSubscribed, readyGraceElapsed, register, user]);

  // Between registering and the SDK presenting, this backdrop looks like an
  // ordinary screen with a primary button; tapping it would mount the account
  // step underneath a paywall that then presents on top of it.
  const ctaDisabled = presenting && state.status === 'idle' && !escapeElapsed;

  return (
    <OnboardingShell
      title="Go further with OpenWhispr Pro."
      titleAccent="Pro"
      subtitle="You've seen what it can do. Unlock the whole thing."
      ctaLabel="Continue"
      ctaDisabled={ctaDisabled}
      onCta={advance}
    >
      <View className="gap-4 pt-2">
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
