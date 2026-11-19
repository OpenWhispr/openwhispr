import { useEffect, useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import registry from '@/config/languageRegistry.json';
import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import { needsReconnect } from '@/android/calendar/connect';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { cloudAccessFor } from '@/lib/aiWorkflows';
import { useSyncStore } from '@/sync/useSyncStore';
import { requestSync } from '@/sync/syncEngine';
import { requiresRealAccount } from '@/lib/accountAccess';
import { getAccountDisplay } from '@/lib/accountDisplay';
import { safeHaptics } from '@/lib/utils';
import { AndroidDictation } from '../../modules/android-dictation/src';
import { gloss, home, type } from '@/android/home/kit';
import { look } from '@/android/settings/look';
import {
  Group,
  ListRow,
  PillAction,
  SettingsPage,
  cardStyle,
  relativeTime,
  settings,
  showToast,
} from '@/android/settings/kit';
import { useSettingsT, type SettingsKey } from '@/android/settings/strings';
import { requestRuntime, usePermissions } from '@/android/settings/permissions';
import {
  applyBubbleLook,
  sizeLabel,
  useBubbleLook,
  useHoldAction,
} from '@/android/settings/bubbleAppearance';
import { processingSummary } from '@/android/processingFable/places';

const HISTORY_LABEL: Record<number, SettingsKey> = {
  [-1]: 'forever',
  30: 'thirtyDays',
  7: 'sevenDays',
  0: 'dontSave',
};

export default function SettingsScreen() {
  const t = useSettingsT();
  const user = useAuthStore((s) => s.user);
  const isGuest = useAuthStore((s) => s.isGuest);
  const signOut = useAuthStore((s) => s.signOut);
  const usage = useUsageStore((s) => s.usage);
  const loadUsage = useUsageStore((s) => s.load);
  const config = useConfigStore((s) => s.config);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const processing = processingSummary(t, config, activeMode, cloudAccessFor(user));
  const sync = useSyncStore();
  const opacity = useBubbleLook((s) => s.opacity);
  const holdAction = useHoldAction((s) => s.value);
  const { status, offCount, refresh } = usePermissions();
  const [switching, setSwitching] = useState(false);
  const signedIn = !requiresRealAccount(user);
  const bubbleSize = config?.androidBubbleSize ?? 64;

  useEffect(() => {
    if (signedIn) loadUsage();
  }, [signedIn, loadUsage]);

  const calendarAccounts = useGoogleCalendarStore((state) => state.accounts);
  const loadCalendars = useGoogleCalendarStore((state) => state.load);
  useEffect(() => {
    if (signedIn) loadCalendars().catch(() => undefined);
  }, [signedIn, loadCalendars]);
  // 20.1: one account shows its address, more show how many; any signed out shows that in amber.
  const signedOutCalendars = calendarAccounts.filter((account) => needsReconnect(account)).length;

  const save = async (
    change: Parameters<ReturnType<typeof useConfigStore.getState>['updateConfig']>[0],
  ) => {
    await useConfigStore.getState().updateConfig(change);
    const error = useConfigStore.getState().error;
    if (error) throw new Error(error);
  };

  // The same switch as the Home card. Turning it on asks for what the bubble needs first.
  const setBubble = async (value: boolean) => {
    if (switching || !AndroidDictation) return;
    setSwitching(true);
    try {
      if (value) {
        if (!(await requestRuntime('microphone'))) {
          Alert.alert(t('micOffTitle'), t('micOffBody'), [
            { text: t('notNow'), style: 'cancel' },
            { text: t('openSettings'), onPress: () => AndroidDictation?.openSettings('app') },
          ]);
          return;
        }
        await requestRuntime('notifications');
        if (!AndroidDictation.getStatus().overlay) {
          Alert.alert(t('overlayTitle'), t('overlayBody'), [
            { text: t('cancel'), style: 'cancel' },
            { text: t('turnOn'), onPress: () => AndroidDictation?.openSettings('overlay') },
          ]);
          return;
        }
        applyBubbleLook({ size: bubbleSize });
      }
      AndroidDictation.setEnabled(value, bubbleSize);
      setTimeout(refresh, 300);
    } catch (error) {
      Alert.alert(t('errorTitle'), (error as Error).message);
    } finally {
      setSwitching(false);
    }
  };

  const setBackup = async (value: boolean) => {
    if (value && !signedIn) {
      Alert.alert(t('backupSignInTitle'), t('backupSignInBody'), [
        { text: t('cancel'), style: 'cancel' },
        { text: t('signIn'), onPress: () => router.push('/auth?reason=sync') },
      ]);
      return;
    }
    if (value && sync.subscriptionRequired) {
      Alert.alert(t('backupProTitle'), t('backupProBody'), [
        { text: t('notNow'), style: 'cancel' },
        { text: t('seePlans'), onPress: () => router.push('/android-pro') },
      ]);
      return;
    }
    try {
      await save({ cloudBackupEnabled: value });
      showToast(t(value ? 'backupOn' : 'backupOff'), value ? 'success' : 'neutral');
      if (value) void requestSync('manual').catch(() => undefined);
    } catch (error) {
      showToast((error as Error).message, 'error');
    }
  };

  const backupOn = Boolean(config?.cloudBackupEnabled) && signedIn;
  const backupFailed = backupOn && sync.status === 'error';
  const backupLine = sync.policyBlocked
    ? t('backupOrganization')
    : backupFailed
      ? t('backupFailed')
      : backupOn && sync.lastSyncAt
        ? t('backedUp', { when: relativeTime(sync.lastSyncAt, t) })
        : t('cloudBackupBody');

  const { initials, name } = getAccountDisplay(user, isGuest);
  const language = registry.languages.find(
    (item) => item.code === (config?.preferredLanguage ?? 'auto'),
  );
  const planLabel = usage
    ? usage.isSubscribed
      ? usage.isTrial
        ? t('trial')
        : t('pro')
      : t('free')
    : undefined;
  const bubbleOn = Boolean(status?.enabled);

  return (
    <SettingsPage title={t('settings')}>
      <Group>
        <ListRow
          leading={
            <View
              style={[
                {
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  alignItems: 'center',
                  justifyContent: 'center',
                },
                gloss,
              ]}
            >
              {signedIn ? (
                <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '500', color: '#FFFFFF' }}>
                  {initials}
                </Text>
              ) : (
                <SystemIcon name="person" mdName="UserRound" size={18} color="#FFFFFF" />
              )}
            </View>
          }
          title={signedIn ? name : t('localWorkspace')}
          badge={
            signedIn && planLabel ? (
              <View
                style={{
                  backgroundColor: look.track,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                }}
              >
                <Text
                  style={{
                    fontSize: 11,
                    lineHeight: 14,
                    fontWeight: '500',
                    letterSpacing: 0.11,
                    color: home.secondary,
                    textTransform: 'uppercase',
                  }}
                >
                  {planLabel}
                </Text>
              </View>
            ) : undefined
          }
          subtitle={signedIn ? (user?.email ?? undefined) : t('signInToSync')}
          onPress={() => router.push(signedIn ? '/(account)/profile' : '/auth?reason=sync')}
        />
      </Group>

      {signedIn && usage && (
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          onPress={() => router.push('/android-pro')}
          style={({ pressed }) => [
            cardStyle,
            {
              padding: 16,
              gap: 8,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Text style={[settings.title, { flex: 1 }]}>{t('wordsThisWeek')}</Text>
            {!usage.isSubscribed && (
              <Text style={[settings.title, settings.tabular]}>
                {`${usage.wordsUsed.toLocaleString()} / ${usage.limit.toLocaleString()}`}
              </Text>
            )}
          </View>
          {!usage.isSubscribed && (
            <View
              style={{
                height: 6,
                borderRadius: 999,
                backgroundColor: look.track,
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  height: 6,
                  borderRadius: 999,
                  experimental_backgroundImage: gloss.experimental_backgroundImage,
                  width: `${Math.max(2, Math.min(100, (usage.wordsUsed / Math.max(1, usage.limit)) * 100))}%`,
                }}
              />
            </View>
          )}
          <Text style={[type.footnote, settings.tabular]}>
            {usage.isSubscribed
              ? t('unlimitedWords')
              : t('wordsLeft', { words: Math.max(usage.wordsRemaining, 0).toLocaleString() })}
          </Text>
        </Pressable>
      )}

      <Group title={t('bubble')}>
        <ListRow
          icon="Power"
          title={t('showBubble')}
          toggle={{
            value: bubbleOn,
            disabled: switching,
            onValueChange: (value) => {
              void setBubble(value);
            },
          }}
        />
        <ListRow
          icon="SlidersHorizontal"
          title={t('sizeLook')}
          value={`${t(sizeLabel(bubbleSize))} · ${Math.round(opacity * 100)}%`}
          onPress={() => router.push('/android-size-look')}
        />
        <ListRow
          icon="Pointer"
          title={t('holdBubble')}
          value={t(holdAction === 'nothing' ? 'holdNothing' : 'holdShowMenu')}
          onPress={() => router.push('/android-hold-bubble')}
        />
        <ListRow
          icon="Hand"
          title={t('permissions')}
          value={offCount ? t('toTurnOn', { count: offCount }) : t('allOn')}
          valueAccent={offCount > 0}
          onPress={() => router.push('/android-permissions')}
        />
      </Group>

      <Group title={t('transcription')}>
        <ListRow
          icon="Globe"
          title={t('language')}
          value={!language || language.code === 'auto' ? t('autoDetect') : language.label}
          onPress={() => router.push('/(account)/transcription-language')}
        />
        <ListRow
          icon={processing.icon}
          title={t('processing')}
          value={processing.label}
          onPress={() => router.push('/(account)/ai-models')}
        />
        <ListRow
          icon="Sparkles"
          title={t('textCleanup')}
          subtitle={t('textCleanupBody')}
          toggle={{
            value: config?.cleanupEnabled !== false,
            disabled: !config,
            onValueChange: (cleanupEnabled) => {
              save({ cleanupEnabled }).catch((error: Error) => showToast(error.message, 'error'));
            },
          }}
        />
      </Group>

      <Group title={t('meetings')}>
        <ListRow
          icon="Calendar"
          title={t('calendar')}
          value={
            calendarAccounts.length === 0
              ? t('notConnected')
              : signedOutCalendars > 0
                ? calendarAccounts.length === 1
                  ? t('reconnect')
                  : t('signedOutCount', { count: signedOutCalendars })
                : calendarAccounts.length === 1
                  ? (calendarAccounts[0].email ?? t('calendar'))
                  : t('accountsCount', { count: calendarAccounts.length })
          }
          valueAccent={calendarAccounts.length === 0}
          valueColor={signedOutCalendars > 0 ? '#B45309' : undefined}
          onPress={() => router.push('/android-calendar')}
        />
        <ListRow
          icon="Sparkles"
          title={t('autoRename')}
          subtitle={t('autoRenameBody')}
          toggle={{
            value: config?.autoGenerateNoteTitle !== false,
            disabled: !config,
            onValueChange: (autoGenerateNoteTitle) => {
              save({ autoGenerateNoteTitle }).catch((error: Error) =>
                showToast(error.message, 'error'),
              );
            },
          }}
        />
      </Group>

      <Group title={t('privacy')}>
        <ListRow
          icon="BookOpen"
          title={t('keepHistory')}
          value={t(HISTORY_LABEL[config?.androidHistoryDays ?? -1] ?? 'forever')}
          onPress={() => router.push('/android-history')}
        />
        <ListRow
          icon="Cloud"
          title={t('cloudBackup')}
          subtitle={backupLine}
          subtitleStyle={backupFailed ? { color: look.error } : undefined}
          onPress={
            backupFailed ? () => void requestSync('manual').catch(() => undefined) : undefined
          }
          trailing={null}
          toggle={
            backupFailed
              ? undefined
              : {
                  value: backupOn,
                  disabled: !config || sync.policyBlocked,
                  onValueChange: (value) => {
                    void setBackup(value);
                  },
                }
          }
        />
        <ListRow
          icon="Info"
          title={t('analytics')}
          value={t(config?.usageAnalyticsEnabled === false ? 'off' : 'on')}
          onPress={() => router.push('/(account)/privacy')}
        />
      </Group>

      <Group title="OpenWhispr">
        <ListRow
          icon="CreditCard"
          title={t('plan')}
          value={planLabel}
          onPress={() => router.push('/android-pro')}
        />
        <ListRow
          icon="Gift"
          title={t('referral')}
          onPress={() => router.push('/(account)/referral')}
        />
        <ListRow
          icon="CircleHelp"
          title={t('help')}
          onPress={() => router.push('/(account)/help')}
        />
      </Group>

      {signedIn && (
        <PillAction
          label={t('signOut')}
          icon="LogOut"
          destructive
          onPress={() =>
            Alert.alert(t('signOutTitle'), t('signOutBody'), [
              { text: t('cancel'), style: 'cancel' },
              {
                text: t('signOut'),
                style: 'destructive',
                onPress: () => {
                  safeHaptics('warning');
                  void signOut();
                },
              },
            ])
          }
        />
      )}
    </SettingsPage>
  );
}
