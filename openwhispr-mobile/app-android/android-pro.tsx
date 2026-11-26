import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { SettingsPage } from '@/android/settings/kit';
import { ProContent } from '@/android/Onboarding';
export default function ProScreen() {
  const { t } = useTranslation();
  // `?paywall=limit`: the bubble's "Out of cloud words this week · Go Pro".
  const { paywall } = useLocalSearchParams<{ paywall?: string }>();
  return (
    <SettingsPage title={t('plansAndBilling')} scroll={false}>
      <ProContent openPaywall={paywall === 'limit' ? 'limit' : undefined} />
    </SettingsPage>
  );
}
