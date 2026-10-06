import React, { useCallback, useEffect } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, StyleSheet, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useAuthStore } from '@/store/useAuthStore';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import type { GoogleCalendar, GoogleCalendarAccount } from '@/data/calendarTypes';
import { confirmDestructive } from '@/lib/alerts';
import { cn, getErrorMessage, safeHaptics } from '@/lib/utils';
import { BRAND, iosColor } from '@/config/colors';
import {
  GOOGLE_AUTH_DISCOVERY,
  getGoogleCalendarClientId,
  getGoogleCalendarRedirectUri,
} from '@/services/calendar/googleCalendarConfig';
import { buildGoogleCalendarAuthRequest } from '@/services/calendar/googleCalendarAuth';
import { captureGoogleCalendarException } from '@/services/calendar/googleCalendarTelemetry';

WebBrowser.maybeCompleteAuthSession();

const IS_IOS = Platform.OS === 'ios';

function formatLastSync(value: string | null): string {
  if (!value) return 'Not synced yet';
  const date = new Date(value.endsWith('Z') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return 'Last sync unavailable';
  return `Last synced ${date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

function accountLabel(account: GoogleCalendarAccount): string {
  return account.displayName || account.email || 'Google account';
}

function calendarLabel(calendar: GoogleCalendar): string {
  return calendar.summary || 'Untitled calendar';
}

type StatusBadgeProps = {
  status: GoogleCalendarAccount['status'];
};

function StatusBadge({ status }: StatusBadgeProps) {
  const label =
    status === 'connected' ? 'Connected' : status === 'needs_reconnect' ? 'Reconnect' : 'Error';
  const isConnected = status === 'connected';
  return (
    <View
      style={styles.continuous}
      className={cn(
        'rounded-full px-2 py-0.5',
        isConnected ? 'bg-systemGreen/15' : 'bg-systemRed/15',
      )}
    >
      <Text
        className={cn(
          'text-[11px] font-semibold',
          isConnected ? 'text-systemGreen' : 'text-systemRed',
        )}
      >
        {label}
      </Text>
    </View>
  );
}

type ActionButtonProps = {
  label: string;
  icon: string;
  mdIcon: LucideIconName;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  fullWidth?: boolean;
};

function ActionButton({
  label,
  icon,
  mdIcon,
  onPress,
  loading = false,
  disabled = false,
  destructive = false,
  fullWidth = false,
}: ActionButtonProps) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => ({
        opacity: isDisabled ? 0.5 : pressed ? 0.82 : 1,
        transform: [{ scale: pressed && !isDisabled ? 0.98 : 1 }],
        borderCurve: 'continuous',
      })}
      className={cn(
        'min-h-10 flex-row items-center justify-center gap-2 rounded-lg px-3 py-2.5',
        fullWidth ? 'w-full' : 'flex-1',
        destructive ? 'bg-systemRed/10' : 'bg-tertiarySystemFill',
      )}
    >
      {loading ? (
        <ActivityIndicator size="small" color={destructive ? iosColor('systemRed') : BRAND} />
      ) : (
        <SystemIcon
          name={icon}
          mdName={mdIcon}
          size={16}
          color={destructive ? 'systemRed' : 'label'}
        />
      )}
      <Text
        numberOfLines={1}
        className={cn('text-[14px] font-medium', destructive ? 'text-systemRed' : 'text-label')}
      >
        {label}
      </Text>
    </Pressable>
  );
}

type NoticeProps = {
  title: string;
  message: string;
  tone?: 'neutral' | 'error';
};

function Notice({ title, message, tone = 'neutral' }: NoticeProps) {
  return (
    <View
      style={styles.continuous}
      className={cn(
        'mx-4 mb-5 rounded-[10px] border p-4',
        tone === 'error'
          ? 'border-systemRed/25 bg-systemRed/10'
          : 'border-separator bg-secondarySystemGroupedBackground',
      )}
    >
      <Text
        className={cn(
          'text-base font-semibold',
          tone === 'error' ? 'text-systemRed' : 'text-label',
        )}
      >
        {title}
      </Text>
      <Text className="mt-1 text-sm leading-5 text-secondaryLabel">{message}</Text>
    </View>
  );
}

type ConnectPanelProps = {
  onConnect: () => void;
  connecting: boolean;
};

function ConnectPanel({ onConnect, connecting }: ConnectPanelProps) {
  return (
    <View
      style={styles.continuous}
      className="mx-4 mb-5 rounded-[10px] border border-separator bg-secondarySystemGroupedBackground p-4"
    >
      <View className="flex-row items-start gap-3">
        <View className="h-10 w-10 items-center justify-center rounded-lg bg-brand">
          <SystemIcon name="calendar.badge.plus" mdName="CalendarPlus" size={20} color="#FFF" />
        </View>
        <View className="flex-1">
          <Text className="text-[17px] font-semibold text-label">Google Calendar</Text>
          <Text className="mt-1 text-sm leading-5 text-secondaryLabel">
            Connect calendars to show event suggestions before meeting recordings.
          </Text>
        </View>
      </View>

      <View className="mt-4">
        <ActionButton
          label="Connect"
          icon="link"
          mdIcon="Link"
          onPress={onConnect}
          loading={connecting}
          fullWidth
        />
      </View>
    </View>
  );
}

function OAuthDiagnosticsPanel() {
  if (!__DEV__) return null;
  const clientId = getGoogleCalendarClientId();
  const redirectUri = getGoogleCalendarRedirectUri();
  return (
    <Notice
      title="Developer OAuth diagnostics"
      message={[
        `Client ID: ${clientId || 'missing'}`,
        `Redirect URI: ${redirectUri}`,
        'Register this redirect URI and the matching iOS URL scheme in Google Cloud before testing on device.',
      ].join('\n')}
    />
  );
}

type AccountBlockProps = {
  account: GoogleCalendarAccount;
  calendars: GoogleCalendar[];
  refreshing: boolean;
  disconnecting: boolean;
  togglingCalendarIds: Record<number, boolean>;
  onRefresh: (account: GoogleCalendarAccount) => void;
  onReconnect: () => void;
  onDisconnect: (account: GoogleCalendarAccount) => void;
  onToggleCalendar: (
    account: GoogleCalendarAccount,
    calendar: GoogleCalendar,
    selected: boolean,
  ) => void;
};

function AccountBlock({
  account,
  calendars,
  refreshing,
  disconnecting,
  togglingCalendarIds,
  onRefresh,
  onReconnect,
  onDisconnect,
  onToggleCalendar,
}: AccountBlockProps) {
  const visibleCalendars = calendars.filter((calendar) => !calendar.deletedAt);
  const selectedCount = visibleCalendars.filter((calendar) => calendar.selected === 1).length;

  return (
    <View
      style={styles.continuous}
      className="mx-4 mb-5 rounded-[10px] border border-separator bg-secondarySystemGroupedBackground"
    >
      <View className="px-4 py-4">
        <View className="flex-row items-start gap-3">
          <View className="h-10 w-10 items-center justify-center rounded-lg bg-tertiarySystemFill">
            <SystemIcon
              name="person.crop.circle"
              mdName="CircleUserRound"
              size={22}
              color="label"
            />
          </View>
          <View className="flex-1">
            <View className="flex-row items-start gap-2">
              <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-[17px] font-semibold text-label">
                  {accountLabel(account)}
                </Text>
                {account.email ? (
                  <Text numberOfLines={1} className="mt-0.5 text-sm text-secondaryLabel">
                    {account.email}
                  </Text>
                ) : null}
              </View>
              <StatusBadge status={account.status} />
            </View>
            <Text className="mt-1.5 text-xs text-tertiaryLabel">
              {formatLastSync(account.lastSyncAt)}
            </Text>
          </View>
        </View>

        {account.lastError ? (
          <View style={styles.continuous} className="mt-3 rounded-lg bg-systemRed/10 px-3 py-2.5">
            <Text className="text-xs leading-4 text-systemRed">{account.lastError}</Text>
          </View>
        ) : null}

        <View className="mt-4 flex-row gap-2">
          <ActionButton
            label="Refresh"
            icon="arrow.clockwise"
            mdIcon="RefreshCw"
            onPress={() => onRefresh(account)}
            loading={refreshing}
            disabled={disconnecting}
          />
          {account.status === 'needs_reconnect' || account.status === 'error' ? (
            <ActionButton
              label="Reconnect"
              icon="link"
              mdIcon="Link"
              onPress={onReconnect}
              disabled={refreshing || disconnecting}
            />
          ) : null}
          <ActionButton
            label="Disconnect"
            icon="trash"
            mdIcon="Trash2"
            onPress={() => onDisconnect(account)}
            loading={disconnecting}
            disabled={refreshing}
            destructive
          />
        </View>
      </View>

      <View className="h-px bg-separator" />

      <View className="px-4 py-3">
        <View className="mb-2 flex-row items-center justify-between gap-3">
          <Text className="text-[13px] font-semibold uppercase tracking-wider text-secondaryLabel">
            Calendars
          </Text>
          <Text className="text-xs text-tertiaryLabel">{selectedCount} selected</Text>
        </View>

        {visibleCalendars.length === 0 ? (
          <Text className="py-2 text-sm text-secondaryLabel">
            Refresh after connecting to load your calendar list.
          </Text>
        ) : (
          visibleCalendars.map((calendar, index) => {
            const isToggling = !!togglingCalendarIds[calendar.id];
            const isSelected = calendar.selected === 1;
            return (
              <View key={calendar.id}>
                {index > 0 ? <View className="ml-10 h-px bg-separator" /> : null}
                <View className="min-h-12 flex-row items-center gap-3 py-2.5">
                  <View className="h-7 w-7 items-center justify-center rounded-md bg-tertiarySystemFill">
                    <SystemIcon
                      name={calendar.isPrimary === 1 ? 'calendar.badge.checkmark' : 'calendar'}
                      mdName={calendar.isPrimary === 1 ? 'CalendarCheck' : 'Calendar'}
                      size={16}
                      color="label"
                    />
                  </View>
                  <View className="min-w-0 flex-1">
                    <Text numberOfLines={1} className="text-[16px] text-label">
                      {calendarLabel(calendar)}
                    </Text>
                    {calendar.isPrimary === 1 || calendar.accessRole ? (
                      <Text numberOfLines={1} className="mt-0.5 text-xs text-tertiaryLabel">
                        {calendar.isPrimary === 1 ? 'Primary calendar' : calendar.accessRole}
                      </Text>
                    ) : null}
                  </View>
                  <SettingsSwitch
                    value={isSelected}
                    disabled={isToggling || refreshing || disconnecting}
                    onValueChange={(next) => onToggleCalendar(account, calendar, next)}
                  />
                </View>
              </View>
            );
          })
        )}
      </View>
    </View>
  );
}

export default function GoogleCalendarIntegrationScreen() {
  const user = useAuthStore((state) => state.user);
  const accounts = useGoogleCalendarStore((state) => state.accounts);
  const calendarsByAccountId = useGoogleCalendarStore((state) => state.calendarsByAccountId);
  const isLoading = useGoogleCalendarStore((state) => state.isLoading);
  const isConnecting = useGoogleCalendarStore((state) => state.isConnecting);
  const refreshingAccountIds = useGoogleCalendarStore((state) => state.refreshingAccountIds);
  const disconnectingAccountIds = useGoogleCalendarStore((state) => state.disconnectingAccountIds);
  const togglingCalendarIds = useGoogleCalendarStore((state) => state.togglingCalendarIds);
  const error = useGoogleCalendarStore((state) => state.error);
  const load = useGoogleCalendarStore((state) => state.load);
  const connect = useGoogleCalendarStore((state) => state.connect);
  const refresh = useGoogleCalendarStore((state) => state.refresh);
  const disconnect = useGoogleCalendarStore((state) => state.disconnect);
  const setCalendarSelected = useGoogleCalendarStore((state) => state.setCalendarSelected);
  const setAuthSessionActive = useGoogleCalendarStore((state) => state.setAuthSessionActive);

  useEffect(() => {
    if (user) {
      load().catch(() => undefined);
    }
  }, [load, user]);

  const handleConnect = useCallback(async () => {
    if (!user) {
      Alert.alert('Sign in required', 'Sign in to connect Google Calendar.');
      return;
    }
    if (!IS_IOS) {
      Alert.alert('Not available', 'Google Calendar integration is available on iOS.');
      return;
    }

    const clientId = getGoogleCalendarClientId();
    if (!clientId) {
      Alert.alert(
        'Google Calendar unavailable',
        'Google Calendar OAuth is not configured for this build.',
      );
      return;
    }

    const request = buildGoogleCalendarAuthRequest(clientId);
    try {
      setAuthSessionActive(true);
      const result = await request.promptAsync(GOOGLE_AUTH_DISCOVERY);
      if (result.type === 'cancel' || result.type === 'dismiss') return;
      if (result.type === 'locked') {
        Alert.alert('Google Calendar', 'Another sign-in flow is already in progress.');
        return;
      }
      if (result.type === 'error') {
        captureGoogleCalendarException(
          result.error ?? new Error('Google Calendar authorization failed'),
          'oauth_prompt',
        );
        Alert.alert(
          'Google Calendar',
          result.error?.message || 'Google Calendar authorization failed.',
        );
        return;
      }
      if (result.type !== 'success') {
        Alert.alert('Google Calendar', 'Google Calendar authorization did not complete.');
        return;
      }
      const code = result.params.code;
      if (!code || !request.codeVerifier) {
        Alert.alert('Google Calendar', 'Google did not return an authorization code.');
        return;
      }

      await connect({
        clientId,
        code,
        codeVerifier: request.codeVerifier,
        redirectUri: request.redirectUri,
      });
      safeHaptics('success');
    } catch (connectError) {
      captureGoogleCalendarException(connectError, 'oauth_connect_ui');
      Alert.alert(
        'Google Calendar',
        getErrorMessage(connectError, 'Unable to connect Google Calendar.'),
      );
    } finally {
      setAuthSessionActive(false);
    }
  }, [connect, setAuthSessionActive, user]);

  const handleRefresh = useCallback(
    async (account: GoogleCalendarAccount) => {
      try {
        safeHaptics('light');
        await refresh(account.id);
      } catch (refreshError) {
        Alert.alert(
          'Refresh failed',
          getErrorMessage(refreshError, 'Unable to refresh Google Calendar.'),
        );
      }
    },
    [refresh],
  );

  const handleDisconnect = useCallback(
    (account: GoogleCalendarAccount) => {
      confirmDestructive(
        'Disconnect Google Calendar?',
        `Remove ${accountLabel(account)} and its cached calendar events from this device?`,
        async () => {
          try {
            await disconnect(account.id);
            safeHaptics('warning');
          } catch (disconnectError) {
            Alert.alert(
              'Disconnect failed',
              getErrorMessage(disconnectError, 'Unable to disconnect Google Calendar.'),
            );
          }
        },
        { destructiveLabel: 'Disconnect' },
      );
    },
    [disconnect],
  );

  const handleToggleCalendar = useCallback(
    async (account: GoogleCalendarAccount, calendar: GoogleCalendar, selected: boolean) => {
      try {
        safeHaptics('selection');
        await setCalendarSelected(account.id, calendar.id, selected);
      } catch (toggleError) {
        Alert.alert(
          'Calendar selection failed',
          getErrorMessage(toggleError, 'Unable to update calendar selection.'),
        );
      }
    },
    [setCalendarSelected],
  );

  if (!IS_IOS) {
    return (
      <SettingsScreen>
        <Notice
          title="Google Calendar is hidden on Android"
          message="Meeting calendar context is currently limited to iOS meeting recordings."
        />
      </SettingsScreen>
    );
  }

  if (!user) {
    return (
      <SettingsScreen>
        <Notice
          title="Sign in required"
          message="Google Calendar can be connected from an OpenWhispr account."
        />
        <View className="mx-4">
          <ActionButton
            label="Sign In"
            icon="person.crop.circle.badge.plus"
            mdIcon="UserPlus"
            onPress={() => router.replace('/')}
          />
        </View>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen>
      {error ? <Notice title="Google Calendar error" message={error} tone="error" /> : null}

      <ConnectPanel onConnect={handleConnect} connecting={isConnecting} />
      <OAuthDiagnosticsPanel />

      {isLoading ? (
        <View className="items-center justify-center py-10">
          <ActivityIndicator size="large" color={BRAND} />
          <Text className="mt-3 text-sm text-secondaryLabel">Loading calendars...</Text>
        </View>
      ) : accounts.length === 0 ? (
        <Notice
          title="No connected calendars"
          message="Connect Google Calendar to keep a local rolling event window for meeting suggestions."
        />
      ) : (
        accounts.map((account) => (
          <AccountBlock
            key={account.id}
            account={account}
            calendars={calendarsByAccountId[account.id] ?? []}
            refreshing={!!refreshingAccountIds[account.id]}
            disconnecting={!!disconnectingAccountIds[account.id]}
            togglingCalendarIds={togglingCalendarIds}
            onRefresh={handleRefresh}
            onReconnect={handleConnect}
            onDisconnect={handleDisconnect}
            onToggleCalendar={handleToggleCalendar}
          />
        ))
      )}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  continuous: {
    borderCurve: 'continuous',
  },
});
