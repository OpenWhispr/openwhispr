import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import type { GoogleCalendarAccount } from '@/data/calendarTypes';
import { safeHaptics } from '@/lib/utils';
import {
  Badge,
  BottomSheet,
  Group,
  ListRow,
  PillAction,
  SettingsPage,
  Toggle,
  showToast,
  useSettings,
} from './kit';
import { GlassButton, OutlineButton } from '../processingFable/look';
import { needsReconnect } from '../calendar/connect';
import { useConnectGoogle } from '../calendar/useConnectGoogle';
import { useSettingsT } from './strings';
import { AmberTag, GoogleTile, accountName, syncedLine } from './calendarParts';

const goBack = () => (router.canGoBack() ? router.back() : router.replace('/android-calendar'));

/**
 * One Google account (Figma 20.3): its card with Sync now and Disconnect, then its calendars
 * with a switch each. Signed out (20.5): Reconnect into that same account, calendars dimmed.
 * Disconnect (20.4) removes this account only and returns to the list.
 */
export default function CalendarAccountScreen() {
  const t = useSettingsT();
  const settings = useSettings();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const accountId = Number(id);
  const accounts = useGoogleCalendarStore((state) => state.accounts);
  const calendars = useGoogleCalendarStore((state) => state.calendarsByAccountId[accountId]);
  const refreshing = useGoogleCalendarStore((state) => state.refreshingAccountIds[accountId]);
  const disconnecting = useGoogleCalendarStore((state) => state.disconnectingAccountIds[accountId]);
  const toggling = useGoogleCalendarStore((state) => state.togglingCalendarIds);
  const load = useGoogleCalendarStore((state) => state.load);
  const refresh = useGoogleCalendarStore((state) => state.refresh);
  const disconnect = useGoogleCalendarStore((state) => state.disconnect);
  const setCalendarSelected = useGoogleCalendarStore((state) => state.setCalendarSelected);
  const google = useConnectGoogle();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  // Kept while the page closes after a disconnect, so it doesn't blank out on the way.
  const found = accounts.find((candidate) => candidate.id === accountId);
  const last = useRef<GoogleCalendarAccount | undefined>(found);
  if (found) last.current = found;
  const account = found ?? last.current;
  useEffect(() => {
    if (!account && accounts.length > 0) goBack();
  }, [account, accounts.length]);
  if (!account) return <SettingsPage title={t('calendar')}>{null}</SettingsPage>;

  const name = accountName(account, t);
  const signedOut = needsReconnect(account);
  const only = accounts.length <= 1;
  const list = calendars ?? [];

  return (
    <SettingsPage title={name}>
      <Group title={t('accountLabel')}>
        <View style={{ padding: 16, gap: 14 }}>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <GoogleTile />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text
                  numberOfLines={1}
                  ellipsizeMode="middle"
                  style={[settings.rowTitle, { flexShrink: 1, flex: 1 }]}
                >
                  {name}
                </Text>
                {signedOut ? (
                  <AmberTag label={t('signedOutTag')} />
                ) : (
                  <Badge label={t('connected')} />
                )}
              </View>
              <Text style={settings.subtitle}>
                {signedOut ? t('signedOutAccountBody') : syncedLine(account, t)}
              </Text>
            </View>
          </View>
          {signedOut ? (
            <View style={{ gap: 10 }}>
              <GlassButton
                label={t(google.connecting ? 'waitingGoogle' : 'reconnect')}
                disabled={google.connecting}
                onPress={() => void google.connect({ account: account.email })}
              />
              <PillAction
                label={t('disconnect')}
                destructive
                busy={disconnecting}
                onPress={() => setConfirming(true)}
              />
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 1 }}>
                <OutlineButton
                  label={t('syncNow')}
                  disabled={refreshing}
                  onPress={() => {
                    safeHaptics('light');
                    refresh(account.id).catch(() => showToast(t('syncFailed'), 'error'));
                  }}
                />
              </View>
              <View style={{ flex: 1 }}>
                <PillAction
                  label={t('disconnect')}
                  destructive
                  busy={disconnecting}
                  onPress={() => setConfirming(true)}
                />
              </View>
            </View>
          )}
        </View>
      </Group>
      {list.length > 0 ? (
        <Group
          title={t('showEventsFrom')}
          footer={
            signedOut
              ? only
                ? undefined
                : t('otherAccountsStillShow')
              : only
                ? t('calendarFooter')
                : t('accountCalendarsFooter')
          }
        >
          {list.map((calendar) => (
            <ListRow
              key={calendar.id}
              icon="Calendar"
              title={calendar.summary ?? t('calendar')}
              subtitle={calendar.isPrimary ? t('primary') : undefined}
              dimmed={signedOut}
              trailing={
                <Toggle
                  label={calendar.summary ?? t('calendar')}
                  value={calendar.selected === 1}
                  disabled={signedOut || toggling[calendar.id]}
                  onValueChange={(selected) => {
                    setCalendarSelected(account.id, calendar.id, selected).catch(() => undefined);
                  }}
                />
              }
            />
          ))}
        </Group>
      ) : null}
      <BottomSheet
        visible={confirming}
        onClose={() => setConfirming(false)}
        title={t('disconnectAccountTitle', { email: name })}
        body={only ? t('disconnectBody', { email: name }) : t('disconnectAccountBody')}
      >
        <View style={{ gap: 10 }}>
          <PillAction
            label={t('disconnect')}
            destructive
            onPress={() => {
              setConfirming(false);
              disconnect(account.id)
                .then(() => {
                  safeHaptics('warning');
                  showToast(t('accountDisconnected', { email: name }), 'neutral');
                  // Back to the list (20.2), or the connect page (19.2) when it was the last.
                  goBack();
                })
                .catch((error: Error) => showToast(error.message, 'error'));
            }}
          />
          <PillAction label={t('cancel')} onPress={() => setConfirming(false)} />
        </View>
      </BottomSheet>
    </SettingsPage>
  );
}
