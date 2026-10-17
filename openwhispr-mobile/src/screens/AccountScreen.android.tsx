import { useEffect } from 'react';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Text } from '@/components/ui/Text';
import { useUsageStore } from '@/store/useUsageStore';
import { useAuthStore } from '@/store/useAuthStore';
import { Page, Section, Row, styles } from '@/android/ui';

export default function AndroidAccount() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const subscribed = useUsageStore((s) => s.usage?.isSubscribed);
  const loadUsage = useUsageStore((s) => s.load);
  useEffect(() => {
    if (user && !user.isAnonymous) loadUsage();
  }, [user, loadUsage]);
  return (
    <Page title={t('account')} back>
      <Text accessibilityRole="header" style={styles.title}>
        {user?.name || t('signedOut')}
      </Text>
      <Section title={t('account')}>
        <Row
          icon="UserRound"
          title={!user || user.isAnonymous ? t('signIn') : user.email}
          onPress={() => router.push(!user || user.isAnonymous ? '/auth' : '/(account)/profile')}
        />
        <Row
          icon="Sparkles"
          title={t('plansAndBilling')}
          detail={
            subscribed === undefined ? undefined : t(subscribed ? 'cloudUnlimited' : 'proBody')
          }
          onPress={() => router.push('/android-pro')}
        />
      </Section>
      <Section title={t('preferences')}>
        <Row
          icon="SlidersHorizontal"
          title={t('preferences')}
          detail={t('preferencesSummary')}
          onPress={() => router.push('/(account)/preferences')}
        />
        <Row
          icon="Cpu"
          title={t('models')}
          detail={t('processingSummary')}
          onPress={() => router.push('/(account)/ai-models')}
        />
        <Row
          icon="ShieldCheck"
          title={t('privacyData')}
          detail={t('privacySummary')}
          onPress={() => router.push('/(account)/privacy')}
        />
      </Section>
      <Section title="OpenWhispr">
        <Row icon="Gift" title={t('referrals')} onPress={() => router.push('/(tabs)/(referral)')} />
        <Row
          icon="CircleHelp"
          title={t('helpAbout')}
          onPress={() => router.push('/(account)/help')}
        />
      </Section>
    </Page>
  );
}
