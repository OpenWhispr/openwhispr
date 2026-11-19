import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/useAuthStore';
import { meetingOnDevice } from './meetingRouting';
import { requiresRealAccount } from '@/lib/accountAccess';
import { Text } from '@/components/ui/Text';
import { Button, Card, styles } from './ui';

export function MeetingSetup({ onStart, busy }: { onStart: () => void; busy: boolean }) {
  const { t } = useTranslation('android');
  const user = useAuthStore((state) => state.user);
  // Meetings set to run on the phone record locally; the others connect live.
  const privateMode = meetingOnDevice();
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
          <Button label={t('signIn')} onPress={() => router.push('/auth')} />
        ) : (
          <Button label={t('meetingStart')} busy={busy} onPress={onStart} />
        )}
      </Card>
    </ScrollView>
  );
}
