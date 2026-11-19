const mockAuthorizeGoogle = jest.fn();
const mockClearGoogleToken = jest.fn(async (_token: string) => undefined);
const mockSetItem = jest.fn(async () => undefined);

jest.mock('../../../../modules/google-authorization/src', () => ({
  authorizeGoogle: (...args: unknown[]) => mockAuthorizeGoogle(...args),
  clearGoogleToken: (token: string) => mockClearGoogleToken(token),
}));
jest.mock('expo-secure-store', () => ({
  setItemAsync: (...args: unknown[]) => mockSetItem(...(args as [])),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

import { GoogleCalendarAuthError } from '../googleCalendarAuth';
import {
  authorizeGoogleCalendarOnAndroid,
  forgetAndroidGoogleCalendarToken,
  getAndroidGoogleCalendarAccessToken,
} from '../googleCalendarAndroidAuth';
import type { GoogleCalendarAccount } from '@/data/calendarTypes';

const CALENDAR_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

const userinfo = (body: unknown, status = 200) =>
  jest.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response);

const account = {
  id: 7,
  googleSubject: 'sub-1',
  email: 'sam@example.com',
} as GoogleCalendarAccount;

const codedError = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => jest.clearAllMocks());

it('connects with Google’s sheet and names the account from userinfo', async () => {
  mockAuthorizeGoogle.mockResolvedValueOnce({ accessToken: 'tok', grantedScopes: CALENDAR_SCOPES });
  const fetchUserinfo = userinfo({ sub: 'sub-1', email: 'sam@example.com', name: 'Sam' });

  const result = await authorizeGoogleCalendarOnAndroid(fetchUserinfo);

  expect(mockAuthorizeGoogle).toHaveBeenCalledWith(expect.arrayContaining(['openid', 'email']), {
    interactive: true,
  });
  expect(fetchUserinfo).toHaveBeenCalledWith('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: 'Bearer tok' },
  });
  expect(result.identity).toEqual({ sub: 'sub-1', email: 'sam@example.com', name: 'Sam' });
  expect(result.tokens).toMatchObject({
    accessToken: 'tok',
    refreshToken: null,
    scopes: CALENDAR_SCOPES,
  });
});

it('treats a closed sheet as cancelled', async () => {
  mockAuthorizeGoogle.mockRejectedValueOnce(codedError('CANCELLED'));
  await expect(authorizeGoogleCalendarOnAndroid(userinfo({}))).rejects.toMatchObject({
    code: 'cancelled',
  });
});

it('refuses a grant without the calendar scopes', async () => {
  mockAuthorizeGoogle.mockResolvedValueOnce({ accessToken: 'tok', grantedScopes: ['openid'] });
  await expect(authorizeGoogleCalendarOnAndroid(userinfo({ sub: 's' }))).rejects.toMatchObject({
    code: 'missing_required_scopes',
  });
});

it('fails when Google won’t say who the account is', async () => {
  mockAuthorizeGoogle.mockResolvedValueOnce({ accessToken: 'tok', grantedScopes: CALENDAR_SCOPES });
  await expect(authorizeGoogleCalendarOnAndroid(userinfo({}, 401))).rejects.toBeInstanceOf(
    GoogleCalendarAuthError,
  );
});

it('refreshes a connected account without UI and stores the new token', async () => {
  mockAuthorizeGoogle.mockResolvedValueOnce({ accessToken: 'new', grantedScopes: CALENDAR_SCOPES });

  await expect(getAndroidGoogleCalendarAccessToken(account)).resolves.toBe('new');

  expect(mockAuthorizeGoogle).toHaveBeenCalledWith(expect.any(Array), {
    account: 'sam@example.com',
    interactive: false,
  });
  expect(mockSetItem).toHaveBeenCalledWith(
    'google-calendar.tokens.sub-1',
    expect.stringContaining('"accessToken":"new"'),
  );
});

it('asks for a reconnect when the grant needs the user again', async () => {
  mockAuthorizeGoogle.mockRejectedValueOnce(codedError('CONSENT_REQUIRED'));
  await expect(getAndroidGoogleCalendarAccessToken(account)).rejects.toMatchObject({
    code: 'consent_required',
  });
  expect(mockSetItem).not.toHaveBeenCalled();
});

it('clears a revoked token from Play services’ cache, ignoring failures', async () => {
  mockClearGoogleToken.mockRejectedValueOnce(new Error('gone'));
  await expect(forgetAndroidGoogleCalendarToken('tok')).resolves.toBeUndefined();
  expect(mockClearGoogleToken).toHaveBeenCalledWith('tok');
});
