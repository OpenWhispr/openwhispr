import { useEffect, useRef } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/useAuthStore';
import { meetingOnDevice } from './meetingRouting';
import { requiresRealAccount } from '@/lib/accountAccess';
import { Text } from '@/components/ui/Text';
import { Button, Card, styles } from './ui';

/** How long a start from the Notes Start sheet waits for its calendar event to load. */
const AUTOSTART_WAIT_MS = 1500;

export function MeetingSetup({
  onStart,
  busy,
  autoStart = false,
  ready = true,
}: {
  onStart: () => void;
  busy: boolean;
  /** Started from the Notes Start sheet (Figma R0): begin at once instead of asking again. */
  autoStart?: boolean;
  /** Whatever the start needs has loaded (the picked calendar event); waits at most 1.5 s. */
  ready?: boolean;
}) {
  const { t } = useTranslation('android');
  const user = useAuthStore((state) => state.user);
  // Meetings set to run on the phone record locally; the others connect live.
  const privateMode = meetingOnDevice();
  const canStart = privateMode || !requiresRealAccount(user);
  const started = useRef(false);
  const startRef = useRef(onStart);
  startRef.current = onStart;
  useEffect(() => {
    if (!autoStart || !canStart || started.current) return;
    const go = () => {
      if (started.current) return;
      started.current = true;
      startRef.current();
    };
    // After the recorder's own mount effects, which reset its start generation and would
    // otherwise cancel a start made during the same commit.
    const timer = setTimeout(go, ready ? 50 : AUTOSTART_WAIT_MS);
    return () => clearTimeout(timer);
  }, [autoStart, canStart, ready]);
  if (autoStart && canStart && (busy || !started.current))
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('meetingSetupTitle')}
      </Text>
      <Card>
        <Text style={styles.body}>{t(privateMode ? 'meetingLocalBody' : 'meetingCloudBody')}</Text>
        {privateMode ? (
          <>
            <Button label={t('meetingStart')} busy={busy} onPress={onStart} />
            <Button
              secondary
              label={t('models')}
              onPress={() => router.push('/(account)/ai-models')}
            />
          </>
        ) : requiresRealAccount(user) ? (
          <Button label={t('signIn')} onPress={() => router.push('/auth?reason=meeting')} />
        ) : (
          <Button label={t('meetingStart')} busy={busy} onPress={onStart} />
        )}
      </Card>
    </ScrollView>
  );
}
