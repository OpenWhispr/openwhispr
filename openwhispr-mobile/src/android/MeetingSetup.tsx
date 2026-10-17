import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/useAuthStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { requiresRealAccount } from '@/lib/accountAccess';
import { Text } from '@/components/ui/Text';
import { Button, Card, styles } from './ui';

export function MeetingSetup({ onStart, busy }: { onStart: () => void; busy: boolean }) {
  const { t } = useTranslation('android');
  const user = useAuthStore((state) => state.user);
  const privateMode = useProcessingModeStore((state) => state.activeMode === 'private');
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>
        {t('meetingSetupTitle')}
      </Text>
      <Card>
        <Text style={styles.body}>
          {t(privateMode ? 'meetingPrivateBody' : 'meetingCloudBody')}
        </Text>
        {privateMode ? (
          <Button label={t('models')} onPress={() => router.push('/(account)/ai-models')} />
        ) : requiresRealAccount(user) ? (
          <Button label={t('signIn')} onPress={() => router.push('/auth')} />
        ) : (
          <Button label={t('meetingStart')} busy={busy} onPress={onStart} />
        )}
      </Card>
    </ScrollView>
  );
}
