import { observeAndroidLanguage } from './strings';
import './providers/register';
import { watchLocalMode } from './settings/processingDefault';

// Local Mode no longer ties the tasks together: anything that enters it becomes On device.
watchLocalMode();
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { useTranscriptStore } from '@/store/useTranscriptStore';
import { useNotesStore } from '@/store/useNotesStore';
import { startMeetingRecoveryOnce } from '@/lib/meetingRecovery';
import { initSyncTriggers } from '@/sync/syncEngine';
import { PermissionAlertMount } from '@/components/ui/PermissionAlert';
import { OpenWhisprSuperwallProvider } from '@/components/superwall/OpenWhisprSuperwallProvider';
import { View, ActivityIndicator } from 'react-native';
import { Text } from '@/components/ui/Text';
import { Button, styles, palette } from './ui';
import { OpenWhisprMark } from '@/components/ui/OpenWhisprMark';
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

export default function AndroidRoot() {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
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
      dictationEvents?.addListener('onOpenPlans', () => router.push('/android-pro')),
      dictationEvents?.addListener('onOpenSignIn', () => router.push('/auth')),
      dictationEvents?.addListener('onOpenModels', () => router.push('/android-models')),
    ];
    return () => subscriptions.forEach((subscription) => subscription?.remove());
  }, []);
  useRevenueCatIdentity();
  useEffect(() => observeAndroidPurchaseUpdates(), []);
  useEffect(() => observeAndroidLanguage(), []);
  useEffect(() => observeBubbleRestore(), []);
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
  useEffect(() => {
    if (fonts || fontError) SplashScreen.hideAsync().catch(() => undefined);
  }, [fonts, fontError]);
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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <OpenWhisprSuperwallProvider>
          {bootError || accountError ? (
            <View style={[styles.content, { flex: 1, justifyContent: 'center' }]}>
              <Text style={styles.heading}>{t('bootError')}</Text>
              <Text>{bootError || accountError}</Text>
              <Button
                label={t('retry')}
                onPress={() => {
                  forgetAppData();
                  setBootError('');
                  setAttempt((value) => value + 1);
                }}
              />
            </View>
          ) : ready && !accountBlocked && (fonts || fontError) ? (
            <>
              <Stack key={accountRevision} screenOptions={{ headerShown: false }} />
              <SettingsToastHost />
            </>
          ) : (
            <View
              style={[
                styles.content,
                {
                  flex: 1,
                  justifyContent: 'center',
                  alignItems: 'center',
                  backgroundColor: palette.background,
                },
              ]}
            >
              <OpenWhisprMark size={70} color={palette.blue} />
              <Text style={styles.body}>{t('opening')}</Text>
              <ActivityIndicator color={palette.blue} />
            </View>
          )}
          <PermissionAlertMount />
        </OpenWhisprSuperwallProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
