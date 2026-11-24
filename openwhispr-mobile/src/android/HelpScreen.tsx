import { router } from 'expo-router';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { openExternal, openMail } from '@/lib/openExternal';
import { Group, ListRow, SettingsPage, useSettings } from './settings/kit';

export default function HelpScreen() {
  const { t } = useTranslation();
  const settings = useSettings();
  return (
    <SettingsPage title={t('helpAbout')}>
      <Group title={t('support')} inset={14}>
        <ListRow
          title={t('support')}
          onPress={() => {
            void openMail('support@openwhispr.com', 'Android support');
          }}
        />
        <ListRow
          title={t('feedback')}
          onPress={() => {
            void openExternal('https://github.com/OpenWhispr/openwhispr/issues', t('errorTitle'));
          }}
        />
      </Group>
      <Group title={t('about')} inset={14}>
        <ListRow
          title={t('terms')}
          onPress={() => {
            void openExternal('https://openwhispr.com/terms', t('errorTitle'));
          }}
        />
        <ListRow
          title={t('privacy')}
          onPress={() => {
            void openExternal('https://openwhispr.com/privacy', t('errorTitle'));
          }}
        />
        <ListRow title={t('licenses')} onPress={() => router.push('/(account)/licenses')} />
      </Group>
      <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>
        {t('version')} · {Constants.expoConfig?.version}
      </Text>
    </SettingsPage>
  );
}
