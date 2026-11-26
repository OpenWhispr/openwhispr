const mockConnect = jest.fn(async () => ({ id: 1 }));
const mockSetActive = jest.fn();
const mockAuthorize = jest.fn<Promise<unknown>, unknown[]>();
const mockSetItem = jest.fn(async () => undefined);
let mockUser: { id: string } | null = { id: 'u' };
let mockClientId: string | null = 'client.apps.googleusercontent.com';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: (...args: unknown[]) => mockSetItem(...(args as [])),
}));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: mockUser }) },
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/lib/accountAccess', () => ({ requiresRealAccount: (user: unknown) => !user }));
jest.mock('@/android/lib/accountAccess', () => jest.requireMock('@/lib/accountAccess'));
const mockLoad = jest.fn(async () => undefined);
const mockSetState = jest.fn();
let mockAccounts: { googleSubject: string }[] = [];
jest.mock('@/store/useGoogleCalendarStore', () => ({
  useGoogleCalendarStore: {
    getState: () => ({
      setAuthSessionActive: mockSetActive,
      load: mockLoad,
      accounts: mockAccounts,
    }),
    setState: (...args: unknown[]) => mockSetState(...args),
  },
}));
jest.mock('@/services/calendar/googleCalendarConfig', () => ({
  getGoogleCalendarClientId: () => mockClientId,
}));
jest.mock('../googleAuth', () => ({
  authorizeGoogleCalendarOnAndroid: (...args: unknown[]) => mockAuthorize(...args),
  saveAuthorizedGoogleCalendarAccount: (...args: unknown[]) => mockConnect(...(args as [])),
}));
jest.mock('@/services/calendar/googleCalendarTelemetry', () => ({
  captureGoogleCalendarException: jest.fn(),
}));

import { GoogleCalendarAuthError } from '@/services/calendar/googleCalendarAuth.android';
import {
  connectGoogleCalendar,
  dismissCalendarPrompt,
  useCalendarPromptDismissed,
} from '../connect';

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'u' };
  mockClientId = 'client.apps.googleusercontent.com';
  mockAccounts = [];
});

it('says so instead of opening Google when the build has no Android client', async () => {
  mockClientId = null;
  await expect(connectGoogleCalendar()).resolves.toBe('unavailable');
  expect(mockAuthorize).not.toHaveBeenCalled();
});

it('asks to sign in first', async () => {
  mockUser = null;
  await expect(connectGoogleCalendar()).resolves.toBe('signedOut');
});

it("goes back quietly when Google's sheet is closed (C2 → C1)", async () => {
  mockAuthorize.mockRejectedValueOnce(new GoogleCalendarAuthError('cancelled', 'closed'));
  await expect(connectGoogleCalendar()).resolves.toBe('cancelled');
  expect(mockConnect).not.toHaveBeenCalled();
  expect(mockSetActive.mock.calls).toEqual([[true], [false]]);
});

it('saves the account Play services authorized and reloads the shared store', async () => {
  const authorization = { tokens: { accessToken: 't' }, identity: { sub: 's' } };
  mockAuthorize.mockResolvedValueOnce(authorization);
  await expect(connectGoogleCalendar()).resolves.toBe('connected');
  expect(mockConnect).toHaveBeenCalledWith(authorization);
  expect(mockSetState.mock.calls).toEqual([
    [{ isConnecting: true, error: null }],
    [{ isConnecting: false }],
  ]);
  expect(mockLoad).toHaveBeenCalled();
});

it('tells 20.2 whether the account was new, so re-adding one opens its page', async () => {
  const onConnected = jest.fn();
  mockAccounts = [{ googleSubject: 's' }];
  mockAuthorize.mockResolvedValueOnce({ tokens: {}, identity: { sub: 's' } });
  await connectGoogleCalendar({ onConnected });
  expect(onConnected).toHaveBeenCalledWith(1, true);
  mockAuthorize.mockResolvedValueOnce({ tokens: {}, identity: { sub: 'new' } });
  await connectGoogleCalendar({ onConnected });
  expect(onConnected).toHaveBeenLastCalledWith(1, false);
});

it('reconnects the signed-out account it names, without the picker (20.5)', async () => {
  mockAuthorize.mockResolvedValueOnce({ tokens: {}, identity: { sub: 's' } });
  await connectGoogleCalendar({ account: 'alex@oldjob.com' });
  expect(mockAuthorize).toHaveBeenCalledWith(undefined, { account: 'alex@oldjob.com' });
});

it('reports a failed sign-in', async () => {
  mockAuthorize.mockRejectedValueOnce(new GoogleCalendarAuthError('authorization_failed', 'x'));
  await expect(connectGoogleCalendar()).resolves.toBe('failed');
  expect(mockSetActive.mock.calls).toEqual([[true], [false]]);
});

it('remembers × on this phone (C4)', () => {
  dismissCalendarPrompt();
  expect(useCalendarPromptDismissed.getState().dismissed).toBe(true);
  expect(mockSetItem).toHaveBeenCalledWith('android.notes.calendarPromptDismissed', '1');
});
