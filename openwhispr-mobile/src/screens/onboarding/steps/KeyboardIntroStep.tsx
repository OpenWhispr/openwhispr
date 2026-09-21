import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, type AppStateStatus, View } from 'react-native';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { AnimatedKeyboardPreview } from '@/components/onboarding/AnimatedKeyboardPreview';
import { FullAccessReasons } from '@/components/onboarding/FullAccessReasons';
import { InstructionOverlay } from '@/components/onboarding/InstructionOverlay';
import { getStepProgress, useOnboardingStore } from '@/store/useOnboardingStore';
import { isKeyboardInstalled } from '@/lib/keyboardInstallation';
import { startKeyboardPipTutorial, stopKeyboardPipTutorial } from '@/lib/keyboardPipTutorial';

const STEP_ID = 'keyboard-intro';

const STEPS = [
  'Tap Keyboards',
  'Enable OpenWhispr',
  'Allow Full Access',
  'Tap Allow on the popup',
  'Come back into the app',
];

export function KeyboardIntroStep() {
  const goNext = useOnboardingStore((s) => s.goNext);
  const setKeyboardInstalled = useOnboardingStore((s) => s.setKeyboardInstalled);
  const [openedSettings, setOpenedSettings] = useState(false);
  const [hasReturned, setHasReturned] = useState(false);
  const [settingsLaunchPending, setSettingsLaunchPending] = useState(false);
  const leftAppRef = useRef(false);
  const settingsLaunchInFlightRef = useRef(false);
  const skipCheckRef = useRef(false);

  const stopPipTutorial = useCallback(() => {
    stopKeyboardPipTutorial();
  }, []);

  // Mirror MicrophoneStep's auto-skip pattern: if the OpenWhispr keyboard is
  // already enabled in iOS, advance immediately without showing this screen.
  useEffect(() => {
    if (skipCheckRef.current) return;
    skipCheckRef.current = true;
    if (isKeyboardInstalled()) {
      stopPipTutorial();
      setKeyboardInstalled(true).then(() => goNext());
    }
  }, [goNext, setKeyboardInstalled, stopPipTutorial]);

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
            setKeyboardInstalled(true).then(() => goNext());
            return;
          }
          attempts += 1;
          if (attempts >= maxAttempts) {
            stopPolling();
            setHasReturned(true);
          }
        };
        tryDetect();
        if (!pollHandle) {
          pollHandle = setInterval(tryDetect, 200);
        }
      }
    });
    return () => {
      subscription.remove();
      stopPolling();
      stopPipTutorial();
    };
  }, [goNext, setKeyboardInstalled, stopPipTutorial]);

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

  const handleConfirm = useCallback(async () => {
    stopPipTutorial();
    await setKeyboardInstalled(true);
    await goNext();
  }, [setKeyboardInstalled, goNext, stopPipTutorial]);

  return (
    <OnboardingShell
      progress={getStepProgress(STEP_ID)}
      title={hasReturned ? 'Did you enable the keyboard?' : 'Use OpenWhispr in any app.'}
      titleAccent={hasReturned ? 'enable' : 'any app'}
      subtitle={
        hasReturned
          ? 'We didn’t detect the keyboard yet. Make sure both toggles are on, then try again.'
          : 'Follow these steps in Settings. We’ll be here when you come back.'
      }
      ctaLabel={hasReturned ? 'Try again' : 'Open Settings'}
      ctaDisabled={settingsLaunchPending}
      ctaLoading={settingsLaunchPending}
      onCta={hasReturned ? openSettings : openSettings}
      secondaryCtaLabel={hasReturned ? "I've enabled it" : undefined}
      onSecondaryCta={hasReturned ? handleConfirm : undefined}
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
