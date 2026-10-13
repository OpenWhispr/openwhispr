import type { GoogleCalendar, GoogleCalendarAccount } from '@/data/calendarTypes';
import type { ExchangeGoogleCalendarCodeInput } from '@/services/calendar/googleCalendarAuth';

jest.mock('@/data/calendarRepository', () => ({
  calendarRepository: {
    getAccounts: jest.fn(),
    getCalendars: jest.fn(),
    setCalendarSelected: jest.fn(),
  },
}));
jest.mock('@/services/calendar/GoogleCalendarService', () => ({
  connectGoogleCalendarAccount: jest.fn(),
  refreshGoogleCalendarAccount: jest.fn(),
  disconnectGoogleCalendarAccount: jest.fn(),
}));
jest.mock('@/services/calendar/googleCalendarSync', () => ({
  syncSelectedGoogleCalendarEventWindow: jest.fn(),
}));

import { useGoogleCalendarStore } from '../useGoogleCalendarStore';
import { calendarRepository } from '@/data/calendarRepository';
import {
  connectGoogleCalendarAccount,
  disconnectGoogleCalendarAccount,
  refreshGoogleCalendarAccount,
} from '@/services/calendar/GoogleCalendarService';
import { syncSelectedGoogleCalendarEventWindow } from '@/services/calendar/googleCalendarSync';

const mockCalendarRepository = calendarRepository as unknown as {
  getAccounts: jest.Mock;
  getCalendars: jest.Mock;
  setCalendarSelected: jest.Mock;
};
const mockConnectGoogleCalendarAccount = connectGoogleCalendarAccount as jest.Mock;
const mockRefreshGoogleCalendarAccount = refreshGoogleCalendarAccount as jest.Mock;
const mockDisconnectGoogleCalendarAccount = disconnectGoogleCalendarAccount as jest.Mock;
const mockSyncSelectedGoogleCalendarEventWindow =
  syncSelectedGoogleCalendarEventWindow as jest.Mock;

let mockAccounts: GoogleCalendarAccount[] = [];
let mockCalendarsByAccountId: Record<number, GoogleCalendar[]> = {};

const account = (overrides: Partial<GoogleCalendarAccount> = {}): GoogleCalendarAccount => ({
  id: 1,
  googleSubject: 'google-sub-1',
  email: 'person@example.com',
  displayName: 'Person Example',
  grantedScopes: 'openid email calendar',
  status: 'connected',
  lastSyncAt: null,
  lastError: null,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

const calendar = (overrides: Partial<GoogleCalendar> = {}): GoogleCalendar => ({
  id: 10,
  accountId: 1,
  googleCalendarId: 'primary',
  summary: 'Primary',
  isPrimary: 1,
  accessRole: 'owner',
  selected: 1,
  deletedAt: null,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

const authInput: ExchangeGoogleCalendarCodeInput = {
  clientId: 'client-id',
  code: 'auth-code',
  codeVerifier: 'verifier',
  redirectUri: 'com.example:/oauth2redirect',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAccounts = [];
  mockCalendarsByAccountId = {};
  mockCalendarRepository.getAccounts.mockImplementation(() => mockAccounts);
  mockCalendarRepository.getCalendars.mockImplementation(
    (accountId: number) => mockCalendarsByAccountId[accountId] ?? [],
  );
  mockCalendarRepository.setCalendarSelected.mockImplementation(
    (calendarLocalId: number, selected: boolean) => {
      for (const calendars of Object.values(mockCalendarsByAccountId)) {
        const existing = calendars.find((item) => item.id === calendarLocalId);
        if (existing) existing.selected = selected ? 1 : 0;
      }
    },
  );
  mockConnectGoogleCalendarAccount.mockResolvedValue(account());
  mockRefreshGoogleCalendarAccount.mockResolvedValue(undefined);
  mockDisconnectGoogleCalendarAccount.mockResolvedValue(undefined);
  mockSyncSelectedGoogleCalendarEventWindow.mockResolvedValue(undefined);

  useGoogleCalendarStore.setState({
    accounts: [],
    calendarsByAccountId: {},
    isLoading: false,
    isConnecting: false,
    isAuthSessionActive: false,
    refreshingAccountIds: {},
    disconnectingAccountIds: {},
    togglingCalendarIds: {},
    error: null,
  });
});

describe('useGoogleCalendarStore', () => {
  it('connects an account and refreshes the local account/calendar snapshot', async () => {
    const connectedAccount = account();
    const primaryCalendar = calendar();
    mockConnectGoogleCalendarAccount.mockImplementationOnce(async () => {
      mockAccounts = [connectedAccount];
      mockCalendarsByAccountId = { [connectedAccount.id]: [primaryCalendar] };
      return connectedAccount;
    });

    await expect(useGoogleCalendarStore.getState().connect(authInput)).resolves.toEqual(
      connectedAccount,
    );

    expect(mockConnectGoogleCalendarAccount).toHaveBeenCalledWith(authInput);
    expect(useGoogleCalendarStore.getState()).toEqual(
      expect.objectContaining({
        accounts: [connectedAccount],
        calendarsByAccountId: { [connectedAccount.id]: [primaryCalendar] },
        isConnecting: false,
        error: null,
      }),
    );
  });

  it('sets and clears per-account refresh and disconnect flags', async () => {
    const refresh = deferred<void>();
    const disconnect = deferred<void>();
    mockRefreshGoogleCalendarAccount.mockReturnValueOnce(refresh.promise);
    mockDisconnectGoogleCalendarAccount.mockReturnValueOnce(disconnect.promise);

    const refreshPromise = useGoogleCalendarStore.getState().refresh(1);
    expect(useGoogleCalendarStore.getState().refreshingAccountIds[1]).toBe(true);
    refresh.resolve(undefined);
    await refreshPromise;
    expect(useGoogleCalendarStore.getState().refreshingAccountIds[1]).toBe(false);

    const disconnectPromise = useGoogleCalendarStore.getState().disconnect(1);
    expect(useGoogleCalendarStore.getState().disconnectingAccountIds[1]).toBe(true);
    disconnect.resolve(undefined);
    await disconnectPromise;
    expect(useGoogleCalendarStore.getState().disconnectingAccountIds[1]).toBe(false);
  });

  it('captures and rethrows service errors while clearing in-flight flags', async () => {
    mockAccounts = [account()];
    mockRefreshGoogleCalendarAccount.mockRejectedValueOnce(new Error('Token expired'));

    await expect(useGoogleCalendarStore.getState().refresh(1)).rejects.toThrow('Token expired');

    expect(useGoogleCalendarStore.getState()).toEqual(
      expect.objectContaining({
        error: 'Token expired',
        refreshingAccountIds: { 1: false },
      }),
    );
  });

  it('syncs the event window when selecting a calendar but not when deselecting', async () => {
    mockAccounts = [account()];
    mockCalendarsByAccountId = {
      1: [calendar({ id: 10, selected: 0 })],
    };

    await useGoogleCalendarStore.getState().setCalendarSelected(1, 10, true);

    expect(mockCalendarRepository.setCalendarSelected).toHaveBeenCalledWith(10, true);
    expect(mockSyncSelectedGoogleCalendarEventWindow).toHaveBeenCalledWith(1);
    expect(useGoogleCalendarStore.getState().togglingCalendarIds[10]).toBe(false);

    mockSyncSelectedGoogleCalendarEventWindow.mockClear();
    await useGoogleCalendarStore.getState().setCalendarSelected(1, 10, false);

    expect(mockCalendarRepository.setCalendarSelected).toHaveBeenCalledWith(10, false);
    expect(mockSyncSelectedGoogleCalendarEventWindow).not.toHaveBeenCalled();
    expect(useGoogleCalendarStore.getState().togglingCalendarIds[10]).toBe(false);
  });
});
