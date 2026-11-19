import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import type { GoogleCalendarAccount } from '@/data/calendarTypes';
import { safeHaptics } from '@/lib/utils';
import { home, type } from '../home/kit';
import { look, edgeCard } from './look';
import {
  Badge,
  BottomSheet,
  Group,
  ListRow,
  PillAction,
  SettingsPage,
  Toggle,
  relativeTime,
  settings,
  showToast,
} from './kit';
import { GlassButton, OutlineButton } from '../processingFable/look';
import { needsReconnect } from '../calendar/connect';
import { useConnectGoogle } from '../calendar/useConnectGoogle';
import { useSettingsT } from './strings';

const AMBER = '#B45309';

/**
 * Settings → Calendar (Figma 19.2–19.6): Google only, read only, one or more accounts with a
 * switch per calendar. The same store as the Notes prompt, so both read the same connection.
 */
export default function CalendarScreen() {
  const t = useSettingsT();
  const accounts = useGoogleCalendarStore((state) => state.accounts);
  const calendarsByAccountId = useGoogleCalendarStore((state) => state.calendarsByAccountId);
  const refreshing = useGoogleCalendarStore((state) => state.refreshingAccountIds);
  const disconnecting = useGoogleCalendarStore((state) => state.disconnectingAccountIds);
  const toggling = useGoogleCalendarStore((state) => state.togglingCalendarIds);
  const load = useGoogleCalendarStore((state) => state.load);
  const refresh = useGoogleCalendarStore((state) => state.refresh);
  const disconnect = useGoogleCalendarStore((state) => state.disconnect);
  const setCalendarSelected = useGoogleCalendarStore((state) => state.setCalendarSelected);
  const google = useConnectGoogle();
  const [confirming, setConfirming] = useState<GoogleCalendarAccount | null>(null);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  if (accounts.length === 0)
    return (
      <SettingsPage title={t('calendar')}>
        <Group title={t('googleCalendar')}>
          <View style={{ padding: 16, gap: 14 }}>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <GoogleTile />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={settings.rowTitle}>{t('googleCalendar')}</Text>
                <Text style={settings.subtitle}>{t('googleCalendarBody')}</Text>
              </View>
            </View>
            <GlassButton
              label={t(google.connecting ? 'waitingGoogle' : 'connectGoogle')}
              disabled={google.connecting}
              onPress={() => void google.connect()}
            />
          </View>
        </Group>
        <Group title={t('whatWeRead')} footer={t('keptSevenDays')}>
          <ListRow icon="Calendar" title={t('readTitles')} trailing={null} />
          <ListRow icon="Users" title={t('readGuests')} trailing={null} />
          <ListRow icon="Lock" title={t('readOnly')} subtitle={t('readOnlyBody')} trailing={null} />
        </Group>
      </SettingsPage>
    );

  return (
    <SettingsPage title={t('calendar')}>
      {accounts.map((account) => {
        const signedOut = needsReconnect(account);
        const calendars = calendarsByAccountId[account.id] ?? [];
        return (
          <React.Fragment key={account.id}>
            <Group title={t('accountLabel')}>
              <View style={{ padding: 16, gap: 14 }}>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <GoogleTile />
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Text numberOfLines={1} style={[settings.rowTitle, { flexShrink: 1 }]}>
                        {account.email ?? account.displayName ?? t('googleCalendar')}
                      </Text>
                      {signedOut ? (
                        <AmberTag label={t('signedOutTag')} />
                      ) : (
                        <Badge label={t('connected')} />
                      )}
                    </View>
                    <Text style={settings.subtitle}>
                      {signedOut
                        ? t('signedOutBody')
                        : account.lastSyncAt
                          ? t('syncedAgo', { when: relativeTime(account.lastSyncAt, t) })
                          : t('notSyncedYet')}
                    </Text>
                  </View>
                </View>
                {signedOut ? (
                  <View style={{ gap: 10 }}>
                    <GlassButton
                      label={t(google.connecting ? 'waitingGoogle' : 'reconnect')}
                      disabled={google.connecting}
                      onPress={() => void google.connect()}
                    />
                    <PillAction
                      label={t('disconnect')}
                      destructive
                      busy={disconnecting[account.id]}
                      onPress={() => setConfirming(account)}
                    />
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <OutlineButton
                        label={t('syncNow')}
                        disabled={refreshing[account.id]}
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
                        busy={disconnecting[account.id]}
                        onPress={() => setConfirming(account)}
                      />
                    </View>
                  </View>
                )}
              </View>
            </Group>
            {calendars.length > 0 ? (
              <Group title={t('showEventsFrom')}>
                {calendars.map((calendar) => (
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
                          setCalendarSelected(account.id, calendar.id, selected).catch(
                            () => undefined,
                          );
                        }}
                      />
                    }
                  />
                ))}
              </Group>
            ) : null}
          </React.Fragment>
        );
      })}
      <Group footer={t('calendarFooter')}>
        <ListRow
          leading={
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                backgroundColor: look.selFill,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <SystemIcon name="plus" mdName="Plus" size={20} color={home.accent} />
            </View>
          }
          title={t('addGoogleAccount')}
          trailing={null}
          onPress={() => void google.connect()}
        />
      </Group>
      <BottomSheet
        visible={confirming != null}
        onClose={() => setConfirming(null)}
        title={t('disconnectTitle')}
        body={t('disconnectBody', { email: confirming?.email ?? t('googleCalendar') })}
      >
        <View style={{ gap: 10 }}>
          <PillAction
            label={t('disconnect')}
            destructive
            onPress={() => {
              const account = confirming;
              setConfirming(null);
              if (!account) return;
              disconnect(account.id)
                .then(() => {
                  safeHaptics('warning');
                  showToast(t('disconnected'), 'neutral');
                })
                .catch((error: Error) => showToast(error.message, 'error'));
            }}
          />
          <PillAction label={t('cancel')} onPress={() => setConfirming(null)} />
        </View>
      </BottomSheet>
    </SettingsPage>
  );
}

/** The Google "G" on a white glass-edged tile. */
function GoogleTile() {
  return (
    <View
      style={[
        edgeCard,
        { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
      ]}
    >
      <Text style={{ fontSize: 17, fontWeight: '700', color: '#4285F4' }}>G</Text>
    </View>
  );
}

function AmberTag({ label }: { label: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: 'rgba(245,158,11,0.16)',
      }}
    >
      <Text
        style={[type.footnote, { fontSize: 12, lineHeight: 16, color: AMBER, fontWeight: '500' }]}
      >
        {label}
      </Text>
    </View>
  );
}
