import { useTranslation } from 'react-i18next';
import { Page } from '@/android/ui';
import { ProContent } from '@/android/Onboarding';
export default function ProScreen() {
  const { t } = useTranslation();
  return (
    <Page title={t('plansAndBilling')} back>
      <ProContent />
    </Page>
  );
}
