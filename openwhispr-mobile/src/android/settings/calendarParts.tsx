import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import type { GoogleCalendar, GoogleCalendarAccount } from '@/data/calendarTypes';
import { needsReconnect } from '../calendar/connect';
import { type } from '../home/kit';
import { edgeCard } from './look';
import { theme } from '../theme';
import { relativeTime } from './kit';
import type { useSettingsT } from './strings';

export const AMBER = theme.amber;

type T = ReturnType<typeof useSettingsT>;

export function accountName(account: GoogleCalendarAccount, t: T): string {
  return account.email ?? account.displayName ?? t('googleCalendar');
}

export function syncedLine(account: GoogleCalendarAccount, t: T): string {
  return account.lastSyncAt
    ? t('syncedAgo', { when: relativeTime(account.lastSyncAt, t) })
    : t('notSyncedYet');
}

/** 20.2's line under an account: how many calendars are on and when it last synced. */
export function accountSummary(
  account: GoogleCalendarAccount,
  calendars: GoogleCalendar[],
  t: T,
): string {
  if (needsReconnect(account)) return t('reconnectToSee');
  const synced = syncedLine(account, t);
  if (calendars.length === 0) return synced;
  const on = calendars.filter((calendar) => calendar.selected === 1).length;
  return `${t('calendarsOn', { on, total: calendars.length })} · ${synced}`;
}

/** Signed-out accounts first (20.2), otherwise in the order they were connected. */
export function sortAccounts(accounts: GoogleCalendarAccount[]): GoogleCalendarAccount[] {
  return accounts
    .map((account, index) => ({ account, index }))
    .sort(
      (a, b) =>
        Number(needsReconnect(b.account)) - Number(needsReconnect(a.account)) || a.index - b.index,
    )
    .map(({ account }) => account);
}

/** The Google "G" on a white glass-edged tile. */
export function GoogleTile() {
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

export function AmberTag({ label }: { label: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: theme.amberFill,
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
