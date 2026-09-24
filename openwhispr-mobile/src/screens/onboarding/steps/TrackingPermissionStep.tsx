import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { Text } from '@/components/ui/Text';
import { BRAND } from '@/config/colors';
import { setAppsFlyerTrackingAuthorizationStatus } from '@/lib/appsflyer';
import { Sentry } from '@/lib/sentry';
import {
  getTrackingAuthorizationStatus,
  requestTrackingAuthorization,
} from '@/lib/trackingTransparency';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { describeOnboardingError } from '@/lib/onboardingErrors';

type ScreenState = 'checking' | 'ready';

interface Benefit {
  icon: string;
  mdIcon: LucideIconName;
  text: string;
}

const BENEFITS: Benefit[] = [
  { icon: 'chart.bar.fill', mdIcon: 'ChartNoAxesColumn', text: 'Measure which ads work' },
  { icon: 'scope', mdIcon: 'Target', text: 'Make better marketing decisions' },
];

export function TrackingPermissionStep(): ReactElement {
  const { goNext } = useOnboardingStep('tracking-permission');
  const markRequestAttempted = useOnboardingStore(
    (state) => state.markTrackingAuthorizationRequestAttempted,
  );
  const requestAttempted = useOnboardingStore(
    (state) => state.trackingAuthorizationRequestAttempted,
  );
  const [screenState, setScreenState] = useState<ScreenState>('checking');
  const [requesting, setRequesting] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);
  const checkedRef = useRef(false);
  const requestInFlightRef = useRef(false);
  const finishingRef = useRef(false);

  const continueToCompletion = useCallback(async (): Promise<void> => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    setAdvanceError(null);

    try {
      await goNext();
    } catch (error) {
      finishingRef.current = false;
      setAdvanceError(describeOnboardingError(error, 'Could not save progress.'));
    }
  }, [goNext]);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    const checkAuthorization = async (): Promise<void> => {
      try {
        const status = await getTrackingAuthorizationStatus();
        setAppsFlyerTrackingAuthorizationStatus(status);

        if (status !== 'notDetermined' || requestAttempted) {
          await continueToCompletion();
          return;
        }

        setScreenState('ready');
      } catch (error) {
        Sentry.captureException(error);
        await continueToCompletion();
      }
    };

    checkAuthorization().catch((error: unknown): void => {
      Sentry.captureException(error);
    });
  }, [continueToCompletion, requestAttempted]);

  const handleContinue = useCallback(async (): Promise<void> => {
    if (requestInFlightRef.current || finishingRef.current) return;
    requestInFlightRef.current = true;
    setRequesting(true);

    try {
      try {
        // Persist first so a process interruption can never cause a second prompt attempt.
        await markRequestAttempted();
      } catch (error) {
        Sentry.captureException(error);
        await continueToCompletion();
        return;
      }

      try {
        const status = await requestTrackingAuthorization();
        setAppsFlyerTrackingAuthorizationStatus(status);
      } catch (error) {
        Sentry.captureException(error);
      }

      await continueToCompletion();
    } finally {
      requestInFlightRef.current = false;
      setRequesting(false);
    }
  }, [continueToCompletion, markRequestAttempted]);

  if (advanceError) {
    return (
      <OnboardingShell
        title="Your privacy choice is saved"
        subtitle={advanceError}
        ctaLabel="Retry"
        onCta={continueToCompletion}
      >
        <View className="flex-1" />
      </OnboardingShell>
    );
  }

  if (screenState === 'checking') {
    return (
      <OnboardingShell
        title="Checking privacy settings…"
        ctaLabel="Checking…"
        ctaDisabled
        onCta={() => undefined}
      >
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color={BRAND} />
        </View>
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell
      title="Help OpenWhispr grow"
      titleAccent="grow"
      subtitle="Allowing tracking helps us see which ads lead to installs and subscriptions, so we can invest more in improving OpenWhispr."
      ctaLabel="Continue"
      ctaLoading={requesting}
      onCta={handleContinue}
    >
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-grow justify-center pb-4"
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-4 rounded-2xl border border-separator bg-secondarySystemGroupedBackground p-4">
          {BENEFITS.map((benefit) => (
            <View key={benefit.text} className="flex-row items-center gap-3">
              <View className="h-8 w-8 items-center justify-center rounded-xl bg-systemBackground">
                <SystemIcon name={benefit.icon} mdName={benefit.mdIcon} size={17} color="brand" />
              </View>
              <Text className="flex-1 text-[15px] font-medium leading-[20px] text-label">
                {benefit.text}
              </Text>
            </View>
          ))}
        </View>

        <View className="mt-4 flex-row gap-3 rounded-2xl border border-separator bg-secondarySystemGroupedBackground p-4">
          <View className="h-8 w-8 items-center justify-center rounded-xl bg-systemBackground">
            <SystemIcon name="lock.fill" mdName="Lock" size={17} color="brand" />
          </View>
          <View className="flex-1">
            <Text className="text-[15px] font-semibold leading-[20px] text-label">
              Your content stays private
            </Text>
            <Text className="mt-1 text-[14px] leading-[19px] text-secondaryLabel">
              Your recordings, transcriptions, notes, and dictation are never used or shared for
              advertising. Your choice won’t affect your access.
            </Text>
          </View>
        </View>
      </ScrollView>
    </OnboardingShell>
  );
}
