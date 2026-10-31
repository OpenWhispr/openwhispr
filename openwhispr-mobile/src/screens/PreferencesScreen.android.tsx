import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { AndroidDictation } from '../../modules/android-dictation/src';
import { Page, Section, Row } from '@/android/ui';

export default function PreferencesScreen() {
  const { t } = useTranslation();
  return (
    <Page title={t('preferences')} back>
      <Section title={t('dictate')}>
        <Row
          icon="Languages"
          title={t('language')}
          onPress={() => router.push('/(account)/transcription-language')}
        />
        <Row
          icon="Circle"
          title={t('permissions')}
          onPress={() => router.push('/android-permissions')}
        />
      </Section>
      <Section title={t('notifications')}>
        <Row
          icon="Bell"
          title={t('notifications')}
          onPress={() => AndroidDictation?.openSettings('app')}
        />
      </Section>
    </Page>
  );
}
