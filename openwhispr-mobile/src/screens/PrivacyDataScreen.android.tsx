import { useState } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useSyncStore } from '@/sync/useSyncStore';
import { requiresRealAccount } from '@/lib/accountAccess';
import { setInsightsSyncConsent, useInsights } from '@/android/insights';
import { bodyText } from '@/android/settings/look';
import { Group, ListRow, SettingsPage, showToast } from '@/android/settings/kit';
import { noOrphan, useSettingsT } from '@/android/settings/strings';

/** Settings → Privacy → Analytics: two switches and what is never collected. */
export default function AnalyticsScreen() {
  const t = useSettingsT();
  const config = useConfigStore((state) => state.config);
  const signedIn = useAuthStore((state) => !requiresRealAccount(state.user));
  const policyBlocked = useSyncStore((state) => state.policyBlocked);
  const insightsPaused = useInsights((state) => state.consentPaused);
  const [saving, setSaving] = useState(false);

  const guard = async (work: () => Promise<void>) => {
    if (saving) return;
    setSaving(true);
    try {
      await work();
    } catch (error) {
      showToast((error as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const setAnalytics = (usageAnalyticsEnabled: boolean) =>
    guard(async () => {
      await useConfigStore.getState().updateConfig({ usageAnalyticsEnabled });
      const error = useConfigStore.getState().error;
      if (error) throw new Error(error);
      showToast(t(usageAnalyticsEnabled ? 'analyticsOn' : 'analyticsOff'), 'neutral');
    });

  const setStats = (value: boolean) => {
    if (value && !signedIn) {
      Alert.alert(t('statsSignInTitle'), t('statsSignInBody'), [
        { text: t('cancel'), style: 'cancel' },
        { text: t('signIn'), onPress: () => router.push('/auth') },
      ]);
      return;
    }
    if (value && config?.androidHistoryDays === 0) {
      Alert.alert(t('statsHistoryTitle'), t('statsHistoryBody'), [
        { text: t('cancel'), style: 'cancel' },
        { text: t('keepHistoryAction'), onPress: () => router.push('/android-history') },
      ]);
      return;
    }
    void guard(() => setInsightsSyncConsent(value));
  };

  return (
    <SettingsPage title={t('analytics')}>
      <Text textBreakStrategy="balanced" style={bodyText}>
        {noOrphan(t('analyticsIntro'))}
      </Text>
      <Group title={t('share')} inset={14}>
        <ListRow
          title={t('usageAnalytics')}
          subtitle={t('usageAnalyticsBody')}
          toggle={{
            value: config?.usageAnalyticsEnabled ?? true,
            disabled: saving || !config,
            onValueChange: (value) => void setAnalytics(value),
          }}
        />
        <ListRow
          title={t('syncStats')}
          subtitle={t('syncStatsBody')}
          toggle={{
            value: signedIn && config?.insightsSyncEnabled === true && !insightsPaused,
            disabled: saving || !config || policyBlocked,
            onValueChange: setStats,
          }}
        />
      </Group>
      <Group title={t('neverCollected')} inset={14}>
        {(['wordsTranscripts', 'audioRecordings', 'notesDictionary'] as const).map((key) => (
          <ListRow key={key} title={t(key)} value={t('never')} trailing={null} />
        ))}
      </Group>
    </SettingsPage>
  );
}
