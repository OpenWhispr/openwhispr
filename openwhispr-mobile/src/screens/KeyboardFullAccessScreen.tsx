import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, View, type AppStateStatus } from 'react-native';
import { router } from 'expo-router';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { FullAccessReasons } from '@/components/onboarding/FullAccessReasons';
import { InstructionOverlay } from '@/components/onboarding/InstructionOverlay';
import { KeyboardDetectedToast } from '@/components/onboarding/KeyboardDetectedToast';
import { useKeyboardHeartbeat } from '@/hooks/useKeyboardHeartbeat';
import { startKeyboardPipTutorial, stopKeyboardPipTutorial } from '@/lib/keyboardPipTutorial';
import { Sentry } from '@/lib/sentry';
import { useKeyboardRecoveryStore } from '@/store/useKeyboardRecoveryStore';

// Deliberately three steps, not onboarding's five: the keyboard is already
// added by the time a user lands here, so "Enable OpenWhispr" would describe
// something they've done and make the whole list look wrong.
const STEPS = ['Tap Keyboards', 'Allow Full Access', 'Tap Allow on the popup'];

/**
 * Recovery for a keyboard iOS has silently muted: without Full Access the
 * extension can't reach the App Group, so dictation dies while typing keeps
 * working. Reached from the Home banner ("Keyboard dictation not working?") and
 * from Preferences ▸ Keyboard ▸ Full Access — the permanent route, and the only
 * one for a revoke within a single build, which the probe cannot detect. The
 * keyboard itself cannot link here: an extension without Full Access cannot open
 * any URL at all.
 *
 * Both doors are open whether or not the permission is actually missing, so the
 * copy states what Full Access is for rather than asserting that iOS removed it.
 *
 * iOS offers no deep link to the Full Access toggle — `Linking.openSettings()`
 * only ever lands on Settings ▸ OpenWhispr — so the screen has to teach the two
 * taps from there, with the PiP tutorial playing over Settings.
 */
export default function KeyboardFullAccessScreen() {
  const [settingsLaunchPending, setSettingsLaunchPending] = useState(false);
  const leftAppRef = useRef(false);
  const settingsLaunchInFlightRef = useRef(false);

  const dismiss = useCallback(() => {
    stopKeyboardPipTutorial();
    if (router.canGoBack()) {
      router.back();
    } else {
      // Deep-linked entry from the keyboard has no back entry to return to.
      router.replace('/(tabs)/(record)');
    }
  }, []);

  const detected = useKeyboardHeartbeat(dismiss);

  // Scoped to the screen's lifetime so a failed navigation can't strand the
  // flag and pin the app to whatever is on screen.
  useEffect(() => {
    useKeyboardRecoveryStore.getState().setRecoveryActive(true);
    Sentry.addBreadcrumb({
      category: 'keyboard',
      message: 'full access recovery opened',
      level: 'info',
    });
    return () => {
      useKeyboardRecoveryStore.getState().setRecoveryActive(false);
    };
  }, []);

  useEffect(() => {
    if (!detected) return;
    Sentry.addBreadcrumb({
      category: 'keyboard',
      message: 'full access recovery confirmed',
      level: 'info',
    });
  }, [detected]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') {
        leftAppRef.current = true;
        // Only a real background counts: 'inactive' fires for a notification
        // shade or control centre, which is not the user walking away.
        if (next === 'background') useKeyboardRecoveryStore.getState().markBackgrounded();
      } else if (next === 'active' && leftAppRef.current) {
        leftAppRef.current = false;
        stopKeyboardPipTutorial();
      }
    });
    return () => {
      subscription.remove();
      stopKeyboardPipTutorial();
    };
  }, []);

  const openSettings = useCallback(async () => {
    if (settingsLaunchInFlightRef.current) return;
    settingsLaunchInFlightRef.current = true;
    setSettingsLaunchPending(true);

    try {
      await startKeyboardPipTutorial();
      await Linking.openSettings();
    } finally {
      setSettingsLaunchPending(false);
      settingsLaunchInFlightRef.current = false;
    }
  }, []);

  return (
    <>
      <OnboardingShell
        onSkip={dismiss}
        skipLabel="Close"
        title="Dictation needs Full Access."
        titleAccent="Full Access"
        subtitle="Here's how to turn it on for the OpenWhispr keyboard."
        ctaLabel="Open Settings"
        ctaDisabled={settingsLaunchPending}
        ctaLoading={settingsLaunchPending}
        onCta={openSettings}
      >
        <View className="flex-1 justify-center gap-4">
          {/* Visible before the user leaves, not only after: iOS drops them
              on Settings ▸ OpenWhispr with no deeper link available, so they
              need to know the two taps that follow before they get there. */}
          <InstructionOverlay title="Steps to turn it on" steps={STEPS} />
          <FullAccessReasons />
        </View>
      </OnboardingShell>

      {detected ? <KeyboardDetectedToast message="Dictation is back on" /> : null}
    </>
  );
}
