import { useTranslation } from 'react-i18next';
import { SettingsPage } from '@/android/settings/kit';
import { ProContent } from '@/android/Onboarding';
export default function ProScreen() {
  const { t } = useTranslation();
  return (
    <SettingsPage title={t('plansAndBilling')}>
      <ProContent />
    </SettingsPage>
  );
}
