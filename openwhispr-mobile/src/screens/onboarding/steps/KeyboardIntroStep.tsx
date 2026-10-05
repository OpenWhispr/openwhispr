import { useOnboardingStep } from '@/hooks/useOnboardingStep';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, type AppStateStatus, View } from 'react-native';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { AnimatedKeyboardPreview } from '@/components/onboarding/AnimatedKeyboardPreview';
import { FullAccessReasons } from '@/components/onboarding/FullAccessReasons';
import { InstructionOverlay } from '@/components/onboarding/InstructionOverlay';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { isKeyboardInstalled } from '@/lib/keyboardInstallation';
import { startKeyboardPipTutorial, stopKeyboardPipTutorial } from '@/lib/keyboardPipTutorial';
import { describeOnboardingError } from '@/lib/onboardingErrors';

const STEPS = [
  'Tap Keyboards',
  'Enable OpenWhispr',
  'Allow Full Access',
  'Tap Allow on the popup',
  'Come back into the app',
];

export function KeyboardIntroStep() {
  const { goNext, progress } = useOnboardingStep('keyboard-intro');
  const setKeyboardInstalled = useOnboardingStore((s) => s.setKeyboardInstalled);
  const replaying = useOnboardingStore((s) => s.replaying);
  const [installedOnArrival] = useState(() => isKeyboardInstalled());
  const [openedSettings, setOpenedSettings] = useState(false);
  const [hasReturned, setHasReturned] = useState(false);
  const [settingsLaunchPending, setSettingsLaunchPending] = useState(false);
  const leftAppRef = useRef(false);
  const settingsLaunchInFlightRef = useRef(false);
  const skipCheckRef = useRef(false);
  const advancingRef = useRef(false);

  const stopPipTutorial = useCallback(() => {
    stopKeyboardPipTutorial();
  }, []);

  const advance = useCallback(async (): Promise<void> => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    try {
      stopPipTutorial();
      await setKeyboardInstalled(true);
      await goNext();
    } catch (error) {
      advancingRef.current = false;
      setHasReturned(true);
      Alert.alert('Could not continue', describeOnboardingError(error, 'Try again.'));
    }
  }, [goNext, setKeyboardInstalled, stopPipTutorial]);

  // Mirror MicrophoneStep's auto-skip pattern: if the OpenWhispr keyboard is
  // already enabled in iOS, advance immediately without showing this screen.
  // A replay shows it anyway, so Reset onboarding can walk through setup again.
  useEffect(() => {
    if (skipCheckRef.current) return;
    skipCheckRef.current = true;
    if (installedOnArrival && !replaying) {
      stopPipTutorial();
      void advance();
    }
  }, [advance, installedOnArrival, replaying, stopPipTutorial]);

  useEffect(() => {
    let pollHandle: ReturnType<typeof setInterval> | null = null;
    const stopPolling = () => {
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
    };

    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        leftAppRef.current = true;
      } else if (next === 'active' && leftAppRef.current) {
        leftAppRef.current = false;
        stopPipTutorial();

        // iOS may take a moment to update its keyboard registry after the
        // user toggles a custom keyboard on. Poll for ~1s; advance the
        // instant we see our keyboard, otherwise fall back to the manual
        // confirmation prompt.
        let attempts = 0;
        const maxAttempts = 5;
        stopPolling();
        const tryDetect = () => {
          if (isKeyboardInstalled()) {
            stopPolling();
            stopPipTutorial();
            void advance();
            return true;
          }
          attempts += 1;
          if (attempts >= maxAttempts) {
            stopPolling();
            setHasReturned(true);
          }
          return false;
        };
        if (!tryDetect()) {
          pollHandle = setInterval(tryDetect, 200);
        }
      }
    });
    return () => {
      subscription.remove();
      stopPolling();
      stopPipTutorial();
    };
  }, [advance, stopPipTutorial]);

  const openSettings = useCallback(async () => {
    if (settingsLaunchInFlightRef.current) return;
    settingsLaunchInFlightRef.current = true;
    setSettingsLaunchPending(true);
    setOpenedSettings(true);
    setHasReturned(false);

    try {
      await startKeyboardPipTutorial();
      await Linking.openSettings();
    } finally {
      setSettingsLaunchPending(false);
      settingsLaunchInFlightRef.current = false;
    }
  }, []);

  const content =
    replaying && installedOnArrival && !openedSettings
      ? {
          title: 'The keyboard is already on.',
          titleAccent: 'already on',
          subtitle: 'OpenWhispr is enabled in Settings. Continue, or walk through setup again.',
          ctaLabel: 'Continue',
          onCta: advance,
          secondaryCtaLabel: 'Open Settings',
          onSecondaryCta: openSettings,
        }
      : hasReturned
        ? {
            title: 'Did you enable the keyboard?',
            titleAccent: 'enable',
            subtitle:
              'We didn’t detect the keyboard yet. Make sure both toggles are on, then try again.',
            ctaLabel: 'Try again',
            onCta: openSettings,
            secondaryCtaLabel: "I've enabled it",
            onSecondaryCta: advance,
          }
        : {
            title: 'Use OpenWhispr in any app.',
            titleAccent: 'any app',
            subtitle: 'Follow these steps in Settings. We’ll be here when you come back.',
            ctaLabel: 'Open Settings',
            onCta: openSettings,
          };

  return (
    <OnboardingShell
      {...content}
      progress={progress}
      ctaDisabled={settingsLaunchPending}
      ctaLoading={settingsLaunchPending}
    >
      <View className="flex-1 justify-center gap-4">
        {openedSettings ? (
          <InstructionOverlay title="Steps to activate" steps={STEPS} />
        ) : (
          <>
            <AnimatedKeyboardPreview />
            <FullAccessReasons />
          </>
        )}
      </View>
    </OnboardingShell>
  );
}
