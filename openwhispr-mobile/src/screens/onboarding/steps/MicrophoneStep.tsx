import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Linking, View } from 'react-native';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { getStepProgress, useOnboardingStore } from '@/store/useOnboardingStore';
import { getExpoAudioModule } from '@/utils/expoAudio';
import { AppGroupStorage } from '../../../../modules/app-group-storage/src';

const STEP_ID = 'microphone';

type PermissionState = 'checking' | 'undetermined' | 'granted' | 'denied' | 'unavailable';

type RecordingPermissionStatus = { granted: boolean; canAskAgain: boolean };

export function MicrophoneStep() {
  const goNext = useOnboardingStore((s) => s.goNext);
  const setPermissionGranted = useOnboardingStore((s) => s.setPermissionGranted);
  const [state, setState] = useState<PermissionState>('checking');
  const [requesting, setRequesting] = useState(false);
  const requestingRef = useRef(false);
  const advancedRef = useRef(false);

  // Marks the permission as granted and moves on, exactly once — guards against
  // the mount check, the AppState re-check, and the request all racing to advance.
  const advance = useCallback(async () => {
    if (advancedRef.current) return;
    advancedRef.current = true;
    // The native side refuses to warm the dictation mic without permission, so
    // a just-granted permission has to be announced — otherwise warming waits
    // for the next foreground and the keyboard stays "not ready" until then.
    AppGroupStorage.armWarmMic();
    await setPermissionGranted('microphone', true);
    await goNext();
  }, [goNext, setPermissionGranted]);

  const applyStatus = useCallback(
    async (status: RecordingPermissionStatus) => {
      if (status.granted) {
        await advance();
        return;
      }
      setState(status.canAskAgain ? 'undetermined' : 'denied');
    },
    [advance],
  );

  // Initial permission check on mount.
  useEffect(() => {
    const audio = getExpoAudioModule();
    if (!audio) {
      setState('unavailable');
      return;
    }
    audio.AudioModule.getRecordingPermissionsAsync()
      .then(applyStatus)
      .catch(() => setState('undetermined'));
  }, [applyStatus]);

  // Re-check whenever the app returns to the foreground so a grant made in
  // Settings advances the flow without the user tapping again. Skipped while our
  // own system prompt is in flight (handled by handleAllow) to avoid a double advance.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active' || requestingRef.current) return;
      const audio = getExpoAudioModule();
      if (!audio) return;
      audio.AudioModule.getRecordingPermissionsAsync()
        .then(applyStatus)
        .catch(() => {});
    });
    return () => subscription.remove();
  }, [applyStatus]);

  const handleAllow = useCallback(async () => {
    const audio = getExpoAudioModule();
    if (!audio) {
      await goNext();
      return;
    }

    setRequesting(true);
    requestingRef.current = true;
    try {
      const result = await audio.AudioModule.requestRecordingPermissionsAsync();

      if (result.granted) {
        await advance();
        return;
      }

      await setPermissionGranted('microphone', false);

      if (!result.canAskAgain) {
        Alert.alert(
          'Microphone access blocked',
          'Open Settings to grant OpenWhispr access. You can continue setup for now.',
          [
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
            { text: 'Continue', style: 'cancel', onPress: () => goNext() },
          ],
        );
        return;
      }

      await goNext();
    } finally {
      setRequesting(false);
      requestingRef.current = false;
    }
  }, [advance, goNext, setPermissionGranted]);

  const handleOpenSettings = useCallback(() => {
    Linking.openSettings();
  }, []);

  const handleSkip = useCallback(async () => {
    await goNext();
  }, [goNext]);

  const progress = getStepProgress(STEP_ID);

  if (state === 'checking') {
    return (
      <OnboardingShell
        progress={progress}
        title="Checking permissions…"
        ctaLabel="Continue"
        ctaDisabled
        onCta={handleSkip}
      >
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator />
        </View>
      </OnboardingShell>
    );
  }

  if (state === 'denied') {
    return (
      <OnboardingShell
        progress={progress}
        title="Microphone is blocked"
        titleAccent="blocked"
        subtitle="Open Settings to grant OpenWhispr access to your microphone."
        ctaLabel="Open Settings"
        onCta={handleOpenSettings}
        secondaryCtaLabel="Continue anyway"
        onSecondaryCta={handleSkip}
      >
        <View className="flex-1 items-center justify-center">
          <View className="h-28 w-28 items-center justify-center rounded-2xl bg-secondarySystemGroupedBackground">
            <SystemIcon name="mic.slash.fill" mdName="MicOff" size={48} color="secondaryLabel" />
          </View>
        </View>
      </OnboardingShell>
    );
  }

  if (state === 'unavailable') {
    return (
      <OnboardingShell
        progress={progress}
        title="Microphone unavailable"
        subtitle="Audio recording isn't available in this build. You can continue setup."
        ctaLabel="Continue"
        onCta={handleSkip}
      >
        <View className="flex-1" />
      </OnboardingShell>
    );
  }

  return (
    <OnboardingShell
      progress={progress}
      title="Allow microphone access"
      titleAccent="microphone"
      subtitle="Microphone access lets OpenWhispr convert your speech into text."
      ctaLabel="Continue"
      ctaLoading={requesting}
      onCta={handleAllow}
    >
      <View className="flex-1 items-center justify-center">
        <View className="h-28 w-28 items-center justify-center rounded-2xl bg-secondarySystemGroupedBackground">
          <SystemIcon name="mic.fill" mdName="Mic" size={48} color="brand" />
        </View>
      </View>
    </OnboardingShell>
  );
}
