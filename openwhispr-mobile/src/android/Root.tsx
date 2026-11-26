import { observeAndroidLanguage } from './strings';
import './providers/register';
import { watchLocalMode } from './settings/processingDefault';

// Local Mode no longer ties the tasks together: anything that enters it becomes On device.
watchLocalMode();
import { useEffect, useState } from 'react';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import * as SplashScreen from 'expo-splash-screen';
import { useTranscriptStore } from '@/android/store/useTranscriptStore';
import { useNotesStore } from '@/android/store/useNotesStore';
import { startMeetingRecoveryOnce } from '@/lib/meetingRecovery';
import { initSyncTriggers } from '@/sync/syncEngine';
import { PermissionAlertMount } from '@/components/ui/PermissionAlert';
import { OpenWhisprSuperwallProvider } from '@/components/superwall/OpenWhisprSuperwallProvider';
import { useRevenueCatIdentity } from '@/hooks/useRevenueCatIdentity';
import { observeAndroidPurchaseUpdates } from './billing';
import { startBubblePipeline } from './bubblePipeline';
import { bootAppData, forgetAppData } from './appData';
import { dictationEvents } from '../../modules/android-dictation/src';
import { useAccountData } from './accountData';
import { SettingsToastHost } from './settings/kit';
import { loadLearnedWords } from './dictionary/learned';
import { observeBubbleRestore } from './bubbleRestore';
import { useKeepRouteAcrossAccounts } from './useKeepRouteAcrossAccounts';
import { observeEndedSessions } from './authLifecycle';
import { CouldNotOpen, LaunchSplash, SignedOutSheet } from './launch/LaunchScreens';
import { reportAndroidOnboardingDone } from './onboarding/accountOnboarding';
import { prefetchSpeakerModel } from './liveSpeakers/speakerModel';
import { ThemeProvider, useTheme } from './ThemeProvider';

/** The speaker model waits this long after launch, so it never competes with the first screen. */
export const SPEAKER_MODEL_DELAY_MS = 15_000;

/** Past this, the splash says what it's waiting for (D3). Most launches never see it. */
export const SLOW_OPEN_MS = 1500;

/** Dark icons on the light page, light icons on the dark one, switched with the page (§3b). */
function SchemeStatusBar() {
  const { scheme } = useTheme();
  return <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />;
}

export default function AndroidRoot() {
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);
  const [bootError, setBootError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const accountError = useAccountData((state) => state.error);
  const accountRevision = useAccountData((state) => state.revision);
  const accountBlocked = useAccountData((state) => state.blocked);
  const [fonts, fontError] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
  });
  // Signing in or out rebuilds the screens; reopen the one the person was on when it is safe.
  useKeepRouteAcrossAccounts(accountRevision);
  useEffect(() => startBubblePipeline(), []);
  // Which words the person said no to: read before any fix can teach the dictionary.
  useEffect(() => {
    void loadLearnedWords();
  }, []);
  useEffect(() => {
    // The bubble's "open" on a kept result; a cold launch lands on the record tab anyway.
    // The status tab's other actions open the page that fixes what went wrong.
    const subscriptions = [
      dictationEvents?.addListener('onOpenResult', () => router.navigate('/(tabs)/(record)')),
      // Out of cloud words · Go Pro: Plan & billing with the out-of-words paywall over it.
      dictationEvents?.addListener('onOpenPlans', () => router.push('/android-pro?paywall=limit')),
      // An ended session keeps its account, so /auth opens Sign in again (2.5 / 2.5b) for it.
      dictationEvents?.addListener('onOpenSignIn', () => router.push('/auth')),
      dictationEvents?.addListener('onOpenModels', () => router.push('/android-models')),
    ];
    return () => subscriptions.forEach((subscription) => subscription?.remove());
  }, []);
  useRevenueCatIdentity();
  useEffect(() => observeAndroidPurchaseUpdates(), []);
  useEffect(() => observeAndroidLanguage(), []);
  useEffect(() => observeBubbleRestore(), []);
  useEffect(() => observeEndedSessions(), []);
  useEffect(() => {
    async function initialize() {
      await bootAppData();
      // A cold deep link can skip Home, which also initializes app data. Recover
      // interrupted meetings here so every entry route makes their audio retryable.
      useNotesStore.getState().initialize();
      startMeetingRecoveryOnce();
      initSyncTriggers();
      setReady(true);
    }
    initialize().catch((error: Error) => setBootError(error.message));
  }, [attempt]);
  const fontsSettled = Boolean(fonts || fontError);
  const failed = bootError || accountError;
  const showApp = ready && !accountBlocked && fontsSettled;
  // One splash (F1): Android's own stays up until the app can draw its first real screen. Only a
  // slow open hands over, to the identical screen with one line under the icon.
  useEffect(() => {
    if (showApp || failed) return;
    const timer = setTimeout(() => setSlow(true), SLOW_OPEN_MS);
    return () => clearTimeout(timer);
  }, [showApp, failed]);
  useEffect(() => {
    if (showApp || failed || slow) SplashScreen.hideAsync().catch(() => undefined);
  }, [showApp, failed, slow]);
  // A phone that finished onboarding tells each account signed in on it, once (F2).
  useEffect(() => {
    if (ready && !accountBlocked) void reportAndroidOnboardingDone();
  }, [ready, accountRevision, accountBlocked]);
  // Live meeting speaker labels need the 42 MB speaker model before the first meeting starts, so
  // it comes down quietly on any network once the app is open (skipped if it was removed).
  useEffect(() => {
    if (!ready || accountBlocked) return;
    const timer = setTimeout(() => void prefetchSpeakerModel(), SPEAKER_MODEL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ready, accountBlocked]);
  useEffect(() => {
    if (ready && !accountError && !accountBlocked) {
      startMeetingRecoveryOnce();
      useTranscriptStore
        .getState()
        .loadTranscripts()
        .catch(() => undefined);
    }
  }, [ready, accountRevision, accountError, accountBlocked]);
  return (
    <ThemeProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <SchemeStatusBar />
          <OpenWhisprSuperwallProvider>
            {failed ? (
              <CouldNotOpen
                details={failed}
                onRetry={() => {
                  forgetAppData();
                  setBootError('');
                  setSlow(false);
                  setAttempt((value) => value + 1);
                }}
              />
            ) : showApp ? (
              <>
                <Stack key={accountRevision} screenOptions={{ headerShown: false }} />
                <SettingsToastHost />
                <SignedOutSheet />
              </>
            ) : (
              // Under the native splash this is never seen; it takes over at the same pixels.
              <LaunchSplash slow={slow} />
            )}
            <PermissionAlertMount />
          </OpenWhisprSuperwallProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ThemeProvider>
  );
}
