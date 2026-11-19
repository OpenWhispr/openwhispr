import { create } from 'zustand';
import { calendarRepository } from '@/data/calendarRepository';
import type { GoogleCalendar, GoogleCalendarAccount } from '@/data/calendarTypes';
import {
  connectAuthorizedGoogleCalendarAccount,
  connectGoogleCalendarAccount,
  disconnectGoogleCalendarAccount,
  refreshGoogleCalendarAccount,
} from '@/services/calendar/GoogleCalendarService';
import { syncSelectedGoogleCalendarEventWindow } from '@/services/calendar/googleCalendarSync';
import type {
  ExchangeGoogleCalendarCodeInput,
  GoogleCalendarAuthorizationResult,
} from '@/services/calendar/googleCalendarAuth';
import { getErrorMessage } from '@/lib/utils';

type AccountFlagMap = Record<number, boolean>;

type CalendarSnapshot = {
  accounts: GoogleCalendarAccount[];
  calendarsByAccountId: Record<number, GoogleCalendar[]>;
};

interface GoogleCalendarState extends CalendarSnapshot {
  isLoading: boolean;
  isConnecting: boolean;
  isAuthSessionActive: boolean;
  refreshingAccountIds: AccountFlagMap;
  disconnectingAccountIds: AccountFlagMap;
  togglingCalendarIds: AccountFlagMap;
  error: string | null;

  load: () => Promise<void>;
  connect: (input: ExchangeGoogleCalendarCodeInput) => Promise<GoogleCalendarAccount>;
  /** Android: an account Play services already authorized. */
  connectAuthorized: (
    authorization: GoogleCalendarAuthorizationResult,
  ) => Promise<GoogleCalendarAccount>;
  refresh: (accountId: number) => Promise<void>;
  disconnect: (accountId: number) => Promise<void>;
  setCalendarSelected: (
    accountId: number,
    calendarLocalId: number,
    selected: boolean,
  ) => Promise<void>;
  setAuthSessionActive: (active: boolean) => void;
  clearError: () => void;
}

const readSnapshot = (): CalendarSnapshot => {
  const accounts = calendarRepository.getAccounts();
  const calendarsByAccountId: Record<number, GoogleCalendar[]> = {};
  for (const account of accounts) {
    calendarsByAccountId[account.id] = calendarRepository.getCalendars(account.id);
  }
  return { accounts, calendarsByAccountId };
};

const flag = (state: AccountFlagMap, id: number, value: boolean): AccountFlagMap => ({
  ...state,
  [id]: value,
});

async function runConnect(
  set: (partial: Partial<GoogleCalendarState>) => void,
  connect: () => Promise<GoogleCalendarAccount>,
): Promise<GoogleCalendarAccount> {
  set({ isConnecting: true, error: null });
  try {
    const account = await connect();
    set({ ...readSnapshot(), isConnecting: false });
    return account;
  } catch (error) {
    set({
      ...readSnapshot(),
      isConnecting: false,
      error: getErrorMessage(error, 'Failed to connect Google Calendar'),
    });
    throw error;
  }
}

export const useGoogleCalendarStore = create<GoogleCalendarState>((set) => ({
  accounts: [],
  calendarsByAccountId: {},
  isLoading: false,
  isConnecting: false,
  isAuthSessionActive: false,
  refreshingAccountIds: {},
  disconnectingAccountIds: {},
  togglingCalendarIds: {},
  error: null,

  load: async () => {
    set({ isLoading: true, error: null });
    try {
      set({ ...readSnapshot(), isLoading: false });
    } catch (error) {
      set({ isLoading: false, error: getErrorMessage(error, 'Failed to load Google Calendar') });
    }
  },

  connect: (input) => runConnect(set, () => connectGoogleCalendarAccount(input)),
  connectAuthorized: (authorization) =>
    runConnect(set, () => connectAuthorizedGoogleCalendarAccount(authorization)),

  refresh: async (accountId) => {
    set((state) => ({
      refreshingAccountIds: flag(state.refreshingAccountIds, accountId, true),
      error: null,
    }));
    try {
      await refreshGoogleCalendarAccount(accountId);
      set((state) => ({
        ...readSnapshot(),
        refreshingAccountIds: flag(state.refreshingAccountIds, accountId, false),
      }));
    } catch (error) {
      set((state) => ({
        ...readSnapshot(),
        refreshingAccountIds: flag(state.refreshingAccountIds, accountId, false),
        error: getErrorMessage(error, 'Failed to refresh Google Calendar'),
      }));
      throw error;
    }
  },

  disconnect: async (accountId) => {
    set((state) => ({
      disconnectingAccountIds: flag(state.disconnectingAccountIds, accountId, true),
      error: null,
    }));
    try {
      await disconnectGoogleCalendarAccount(accountId);
      set((state) => ({
        ...readSnapshot(),
        disconnectingAccountIds: flag(state.disconnectingAccountIds, accountId, false),
      }));
    } catch (error) {
      set((state) => ({
        ...readSnapshot(),
        disconnectingAccountIds: flag(state.disconnectingAccountIds, accountId, false),
        error: getErrorMessage(error, 'Failed to disconnect Google Calendar'),
      }));
      throw error;
    }
  },

  setCalendarSelected: async (accountId, calendarLocalId, selected) => {
    set((state) => ({
      togglingCalendarIds: flag(state.togglingCalendarIds, calendarLocalId, true),
      error: null,
    }));
    try {
      calendarRepository.setCalendarSelected(calendarLocalId, selected);
      if (selected) {
        await syncSelectedGoogleCalendarEventWindow(accountId);
      }
      set((state) => ({
        ...readSnapshot(),
        togglingCalendarIds: flag(state.togglingCalendarIds, calendarLocalId, false),
      }));
    } catch (error) {
      set((state) => ({
        ...readSnapshot(),
        togglingCalendarIds: flag(state.togglingCalendarIds, calendarLocalId, false),
        error: getErrorMessage(error, 'Failed to update Google Calendar selection'),
      }));
      throw error;
    }
  },

  setAuthSessionActive: (active) => set({ isAuthSessionActive: active }),
  clearError: () => set({ error: null }),
}));
