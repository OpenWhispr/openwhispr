const mockConnect = jest.fn(async () => ({ id: 1 }));
const mockSetActive = jest.fn();
const mockAuthorize = jest.fn();
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
jest.mock('@/lib/accountAccess', () => ({ requiresRealAccount: (user: unknown) => !user }));
jest.mock('@/store/useGoogleCalendarStore', () => ({
  useGoogleCalendarStore: {
    getState: () => ({ connectAuthorized: mockConnect, setAuthSessionActive: mockSetActive }),
  },
}));
jest.mock('@/services/calendar/googleCalendarConfig', () => ({
  getGoogleCalendarClientId: () => mockClientId,
}));
jest.mock('@/services/calendar/googleCalendarAndroidAuth', () => ({
  authorizeGoogleCalendarOnAndroid: () => mockAuthorize(),
}));
jest.mock('@/services/calendar/googleCalendarTelemetry', () => ({
  captureGoogleCalendarException: jest.fn(),
}));

import { GoogleCalendarAuthError } from '@/services/calendar/googleCalendarAuth';
import {
  connectGoogleCalendar,
  dismissCalendarPrompt,
  useCalendarPromptDismissed,
} from '../connect';

beforeEach(() => {
  jest.clearAllMocks();
  mockUser = { id: 'u' };
  mockClientId = 'client.apps.googleusercontent.com';
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

it('connects the account Play services authorized through the shared store', async () => {
  const authorization = { tokens: { accessToken: 't' }, identity: { sub: 's' } };
  mockAuthorize.mockResolvedValueOnce(authorization);
  await expect(connectGoogleCalendar()).resolves.toBe('connected');
  expect(mockConnect).toHaveBeenCalledWith(authorization);
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
