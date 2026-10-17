import { observeAndroidLanguage } from './strings';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Stack } from 'expo-router';
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
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useTranscriptStore } from '@/store/useTranscriptStore';
import { useDictionaryStore } from '@/store/useDictionaryStore';
import { useSnippetsStore } from '@/store/useSnippetsStore';
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
import { useBubblePipeline } from './useBubblePipeline';

export default function AndroidRoot() {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [fonts, fontError] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
  });
  useBubblePipeline();
  useRevenueCatIdentity();
  useEffect(() => observeAndroidPurchaseUpdates(), []);
  useEffect(() => observeAndroidLanguage(), []);
  useEffect(() => {
    async function initialize() {
      await useConfigStore.getState().loadConfig();
      await useAuthStore.getState().initialize();
      await Promise.all([
        useTranscriptStore.getState().loadTranscripts(),
        useDictionaryStore.getState().load(),
        useSnippetsStore.getState().load(),
      ]);
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
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <OpenWhisprSuperwallProvider>
          {bootError ? (
            <View style={[styles.content, { flex: 1, justifyContent: 'center' }]}>
              <Text style={styles.heading}>{t('bootError')}</Text>
              <Text>{bootError}</Text>
              <Button
                label={t('retry')}
                onPress={() => {
                  setBootError('');
                  setAttempt((value) => value + 1);
                }}
              />
            </View>
          ) : ready && (fonts || fontError) ? (
            <Stack screenOptions={{ headerShown: false }} />
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
