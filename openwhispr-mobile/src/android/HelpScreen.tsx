import { router } from 'expo-router';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { openExternal, openMail } from '@/lib/openExternal';
import { Page, Section, Row, styles } from './ui';

export default function HelpScreen() {
  const { t } = useTranslation();
  return (
    <Page title={t('helpAbout')} back>
      <Section title={t('support')}>
        <Row
          icon="Mail"
          title={t('support')}
          onPress={() => {
            void openMail('support@openwhispr.com', 'Android support');
          }}
        />
        <Row
          icon="MessageSquare"
          title={t('feedback')}
          onPress={() => {
            void openExternal('https://github.com/OpenWhispr/openwhispr/issues', t('errorTitle'));
          }}
        />
      </Section>
      <Section title={t('about')}>
        <Row
          title={t('terms')}
          onPress={() => {
            void openExternal('https://openwhispr.com/terms', t('errorTitle'));
          }}
        />
        <Row
          title={t('privacy')}
          onPress={() => {
            void openExternal('https://openwhispr.com/privacy', t('errorTitle'));
          }}
        />
        <Row title={t('licenses')} onPress={() => router.push('/(account)/licenses')} />
      </Section>
      <Text style={styles.caption}>
        {t('version')} · {Constants.expoConfig?.version}
      </Text>
    </Page>
  );
}
