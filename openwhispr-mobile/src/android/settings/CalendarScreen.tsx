import React, { useEffect } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import { safeHaptics } from '@/lib/utils';
import { home } from '../home/kit';
import { look } from './look';
import { Group, ListRow, SettingsPage, settings, showToast } from './kit';
import { GlassButton, OutlineButton } from '../processingFable/look';
import { needsReconnect } from '../calendar/connect';
import { useConnectGoogle } from '../calendar/useConnectGoogle';
import { useSettingsT } from './strings';
import { AmberTag, GoogleTile, accountName, accountSummary, sortAccounts } from './calendarParts';

export function openCalendarAccount(accountId: number) {
  router.push({ pathname: '/android-calendar-account', params: { id: String(accountId) } });
}

/**
 * Settings → Calendar: Google only, read only. With no account it's the connect page (Figma
 * 19.2); with any, a list of accounts (20.2), each opening its own page (20.3). The same store
 * as the Notes prompt, so both read the same connection.
 */
export default function CalendarScreen() {
  const t = useSettingsT();
  const accounts = useGoogleCalendarStore((state) => state.accounts);
  const calendarsByAccountId = useGoogleCalendarStore((state) => state.calendarsByAccountId);
  const refreshing = useGoogleCalendarStore((state) => state.refreshingAccountIds);
  const load = useGoogleCalendarStore((state) => state.load);
  const refresh = useGoogleCalendarStore((state) => state.refresh);
  const google = useConnectGoogle();
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

  const syncable = accounts.filter((account) => !needsReconnect(account));
  const syncing = syncable.some((account) => refreshing[account.id]);
  const syncAll = () => {
    safeHaptics('light');
    Promise.allSettled(syncable.map((account) => refresh(account.id))).then((results) => {
      if (results.some((result) => result.status === 'rejected'))
        showToast(t('syncFailed'), 'error');
    });
  };

  return (
    <SettingsPage title={t('calendar')}>
      <Group title={t('accounts')}>
        {sortAccounts(accounts).map((account) => {
          const name = accountName(account, t);
          return (
            <ListRow
              key={account.id}
              leading={<GoogleTile />}
              title={name}
              singleLineTitle
              badge={needsReconnect(account) ? <AmberTag label={t('signedOutTag')} /> : undefined}
              subtitle={accountSummary(account, calendarsByAccountId[account.id] ?? [], t)}
              onPress={() => openCalendarAccount(account.id)}
            />
          );
        })}
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
          title={t(google.connecting ? 'waitingGoogle' : 'addGoogleAccount')}
          titleColor={home.accent}
          trailing={null}
          onPress={() =>
            void google.connect({
              // An account that's already here just opens (20.2).
              onConnected: (accountId, existed) => {
                if (existed) openCalendarAccount(accountId);
              },
            })
          }
        />
      </Group>
      {syncable.length > 0 ? (
        <OutlineButton label={t('syncAll')} disabled={syncing} onPress={syncAll} />
      ) : null}
      <Text style={[settings.subtitle, { paddingHorizontal: 4 }]}>{t('accountsFooter')}</Text>
    </SettingsPage>
  );
}
