import React, { useCallback, useEffect, useState } from 'react';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { useConfigStore } from '@/store/useConfigStore';
import { useConfigToggle } from '@/hooks/useConfigToggle';
import { useAuthStore } from '@/store/useAuthStore';
import { useNotesStore } from '@/store/useNotesStore';
import { useUsageStore } from '@/store/useUsageStore';
import { useSyncStore } from '@/sync/useSyncStore';
import { requestSync } from '@/sync/syncEngine';
import { formatRelativeTime, safeHaptics } from '@/lib/utils';
import { confirmDestructive } from '@/lib/alerts';

const RELATIVE_TICK_MS = 30_000;

function describeSyncStatus(
  enabled: boolean,
  signedIn: boolean,
  status: string,
  lastSyncAt: string | null,
  paidPlanRequired: boolean,
  policyBlocked: boolean,
): string {
  if (!signedIn) return 'Sign in to enable cloud backup.';
  if (paidPlanRequired) return 'Cloud backup requires Pro. Upgrade in Account → Plans & Billing.';
  if (policyBlocked) return 'Cloud backup is turned off by your organization.';
  if (!enabled)
    return 'Backup is off. Personal notes stay on this device — notes in shared spaces still sync.';
  if (status === 'running') return 'Syncing now…';
  if (status === 'error') return 'Last sync failed. Pull to retry on the Notes tab.';
  if (!lastSyncAt) return 'Notes will sync when you make changes.';
  return `Last synced ${formatRelativeTime(lastSyncAt, 'long').toLowerCase()}.`;
}

export default function PrivacyDataScreen() {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);
  const { status, lastSyncAt, subscriptionRequired, policyBlocked } = useSyncStore();
  const usage = useUsageStore((s) => s.usage);
  const loadUsage = useUsageStore((s) => s.load);
  const voiceProfiles = useNotesStore((s) => s.voiceProfiles);
  const loadVoiceProfiles = useNotesStore((s) => s.loadVoiceProfiles);
  const deleteAllVoiceProfiles = useNotesStore((s) => s.deleteAllVoiceProfiles);
  const cloudBackupEnabled = config?.cloudBackupEnabled ?? true;
  const usageAnalytics = config?.usageAnalyticsEnabled ?? true;
  const signedIn = !!user && !isGuest;
  const paidPlanRequired = usage ? !usage.isSubscribed : subscriptionRequired;

  // Re-render every 30s so "Last synced X ago" stays current without waiting
  // on the next sync event.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), RELATIVE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    loadVoiceProfiles();
  }, [loadVoiceProfiles]);

  useEffect(() => {
    if (signedIn) loadUsage();
  }, [signedIn, loadUsage]);

  const handleToggleCloudBackup = useCallback(
    (value: boolean) => {
      safeHaptics('light');
      updateConfig({ cloudBackupEnabled: value });
      // Toggling ON: kick a sync immediately so the user sees confirmation
      // that things are flowing. Toggling OFF is lazy — the engine guards
      // future triggers; no action needed here.
      if (value) requestSync('manual');
    },
    [updateConfig],
  );

  const handleToggleAnalytics = useConfigToggle('usageAnalyticsEnabled');
  const handleDeleteVoiceProfiles = useCallback(() => {
    confirmDestructive(
      'Delete Voice Profiles',
      'All voice profiles on this device will be permanently deleted. Locked historical labels stay readable.',
      () => {
        safeHaptics('warning');
        deleteAllVoiceProfiles();
      },
    );
  }, [deleteAllVoiceProfiles]);

  const description = describeSyncStatus(
    cloudBackupEnabled,
    signedIn,
    status,
    lastSyncAt,
    paidPlanRequired,
    policyBlocked,
  );

  return (
    <SettingsScreen>
      <SettingsSection title="Sync">
        <SettingsRow
          iconStyle="line"
          icon="icloud"
          mdIcon="Cloud"
          title="Cloud Backup"
          description={description}
          rightElement={
            <SettingsSwitch value={cloudBackupEnabled} onValueChange={handleToggleCloudBackup} />
          }
          showChevron={false}
        />
      </SettingsSection>

      <SettingsSection title="Data">
        <SettingsRow
          iconStyle="line"
          icon="chart.bar"
          mdIcon="BarChart3"
          title="Usage Analytics"
          description="Share performance metrics and app-session analytics to help improve OpenWhispr. Apple’s Tracking permission separately limits advertising attribution on iOS. We never send transcription content."
          rightElement={
            <SettingsSwitch value={usageAnalytics} onValueChange={handleToggleAnalytics} />
          }
          showChevron={false}
        />
        <SettingsRow
          iconStyle="line"
          icon="text.cursor"
          mdIcon="TextCursor"
          title="Dictation Agent Context"
          description="Selected text is always sent to the cloud service when you use the Dictation Agent. If Share Cursor Context is on, the surrounding text near your cursor is also sent. This setting is off by default and can be changed in Dictation Agent settings."
          showChevron={false}
        />
        <SettingsRow
          iconStyle="line"
          icon="waveform"
          mdIcon="AudioLines"
          title="Delete Voice Profiles"
          description={
            voiceProfiles.length === 0
              ? 'No voice profiles are stored on this device.'
              : `${voiceProfiles.length} local voice ${voiceProfiles.length === 1 ? 'profile' : 'profiles'} will be deleted.`
          }
          destructive
          onPress={voiceProfiles.length > 0 ? handleDeleteVoiceProfiles : undefined}
          showChevron={false}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}
