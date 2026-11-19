const mockConnect = jest.fn(async () => ({ id: 1 }));
const mockSetActive = jest.fn();
const mockPrompt = jest.fn();
const mockSetItem = jest.fn(async () => undefined);
let mockUser: { id: string } | null = { id: 'u' };
let mockClientId: string | null = 'client.apps.googleusercontent.com';

jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  dismissAuthSession: jest.fn(),
}));
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
    getState: () => ({ connect: mockConnect, setAuthSessionActive: mockSetActive }),
  },
}));
jest.mock('@/services/calendar/googleCalendarConfig', () => ({
  GOOGLE_AUTH_DISCOVERY: {},
  getGoogleCalendarClientId: () => mockClientId,
}));
jest.mock('@/services/calendar/googleCalendarAuth', () => ({
  buildGoogleCalendarAuthRequest: () => ({
    promptAsync: mockPrompt,
    codeVerifier: 'verifier',
    redirectUri: 'com.gizmolabs.openwhispr:/oauth2redirect',
  }),
}));
jest.mock('@/services/calendar/googleCalendarTelemetry', () => ({
  captureGoogleCalendarException: jest.fn(),
}));

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
  expect(mockPrompt).not.toHaveBeenCalled();
});

it('asks to sign in first', async () => {
  mockUser = null;
  await expect(connectGoogleCalendar()).resolves.toBe('signedOut');
});

it('goes back quietly when Google is closed or refused (C2 → C1)', async () => {
  mockPrompt.mockResolvedValueOnce({ type: 'dismiss' });
  await expect(connectGoogleCalendar()).resolves.toBe('cancelled');
  expect(mockConnect).not.toHaveBeenCalled();
  expect(mockSetActive.mock.calls).toEqual([[true], [false]]);
});

it('connects through the shared store with the Android redirect', async () => {
  mockPrompt.mockResolvedValueOnce({ type: 'success', params: { code: 'abc' } });
  await expect(connectGoogleCalendar()).resolves.toBe('connected');
  expect(mockConnect).toHaveBeenCalledWith({
    clientId: 'client.apps.googleusercontent.com',
    code: 'abc',
    codeVerifier: 'verifier',
    redirectUri: 'com.gizmolabs.openwhispr:/oauth2redirect',
  });
});

it('remembers × on this phone (C4)', () => {
  dismissCalendarPrompt();
  expect(useCalendarPromptDismissed.getState().dismissed).toBe(true);
  expect(mockSetItem).toHaveBeenCalledWith('android.notes.calendarPromptDismissed', '1');
});
