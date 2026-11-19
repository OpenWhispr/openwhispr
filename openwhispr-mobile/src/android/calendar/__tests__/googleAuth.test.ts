const mockAuthorizeGoogle = jest.fn();
const mockChooseGoogleAccount = jest.fn(async (): Promise<string | null> => 'sam@example.com');
const mockClearGoogleToken = jest.fn(async (_token: string) => undefined);
const mockStore = new Map<string, string>();

jest.mock('../../../../modules/android-google-authorization/src', () => ({
  authorizeGoogle: (...args: unknown[]) => mockAuthorizeGoogle(...args),
  chooseGoogleAccount: () => mockChooseGoogleAccount(),
  clearGoogleToken: (token: string) => mockClearGoogleToken(token),
}));
jest.mock('expo-secure-store', () => ({
  setItemAsync: async (key: string, value: string) => void mockStore.set(key, value),
  getItemAsync: async (key: string) => mockStore.get(key) ?? null,
  deleteItemAsync: async (key: string) => void mockStore.delete(key),
}));
jest.mock('@/services/calendar/googleCalendarSync', () => ({
  syncGoogleCalendarList: jest.fn(async () => undefined),
  syncSelectedGoogleCalendarEventWindow: jest.fn(async () => undefined),
}));
jest.mock('@/data/calendarRepository', () => ({ calendarRepository: {} }));
jest.mock('@/services/calendar/googleCalendarTelemetry', () => ({
  captureGoogleCalendarException: jest.fn(),
}));

import {
  GoogleCalendarAuthError,
  refreshStoredGoogleCalendarToken,
  revokeGoogleCalendarToken,
} from '@/services/calendar/googleCalendarAuth.android';
import { authorizeGoogleCalendarOnAndroid } from '../googleAuth';

const CALENDAR_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];

const userinfo = (body: unknown, status = 200) =>
  jest.fn(async () => ({ ok: status < 400, status, json: async () => body }) as Response);

const codedError = (code: string) => Object.assign(new Error(code), { code });

const storeTokens = (tokens: Record<string, unknown>) =>
  mockStore.set('google-calendar.tokens.sub-1', JSON.stringify(tokens));

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
});

describe('connect', () => {
  it('asks for the picked account, then names it from userinfo', async () => {
    mockChooseGoogleAccount.mockResolvedValueOnce('work@example.com');
    mockAuthorizeGoogle.mockResolvedValueOnce({
      accessToken: 'tok',
      grantedScopes: CALENDAR_SCOPES,
    });
    const fetchUserinfo = userinfo({ sub: 'sub-2', email: 'work@example.com', name: 'Sam' });

    const result = await authorizeGoogleCalendarOnAndroid(fetchUserinfo);

    expect(mockAuthorizeGoogle).toHaveBeenCalledWith(expect.arrayContaining(['openid', 'email']), {
      account: 'work@example.com',
      interactive: true,
    });
    expect(fetchUserinfo).toHaveBeenCalledWith('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(result.identity).toEqual({ sub: 'sub-2', email: 'work@example.com', name: 'Sam' });
    expect(result.tokens).toMatchObject({
      accessToken: 'tok',
      refreshToken: null,
      account: 'work@example.com',
    });
  });

  it('skips the picker when reconnecting a named account (20.5)', async () => {
    mockAuthorizeGoogle.mockResolvedValueOnce({
      accessToken: 'tok',
      grantedScopes: CALENDAR_SCOPES,
    });
    await authorizeGoogleCalendarOnAndroid(userinfo({ sub: 'sub-2' }), {
      account: 'old@example.com',
    });
    expect(mockChooseGoogleAccount).not.toHaveBeenCalled();
    expect(mockAuthorizeGoogle).toHaveBeenCalledWith(expect.any(Array), {
      account: 'old@example.com',
      interactive: true,
    });
  });

  it('treats backing out of the account picker as cancelled', async () => {
    mockChooseGoogleAccount.mockResolvedValueOnce(null);
    await expect(authorizeGoogleCalendarOnAndroid(userinfo({}))).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(mockAuthorizeGoogle).not.toHaveBeenCalled();
  });

  it('treats a closed consent sheet as cancelled', async () => {
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

  it("fails when Google won't say who the account is", async () => {
    mockAuthorizeGoogle.mockResolvedValueOnce({
      accessToken: 'tok',
      grantedScopes: CALENDAR_SCOPES,
    });
    await expect(authorizeGoogleCalendarOnAndroid(userinfo({}, 401))).rejects.toBeInstanceOf(
      GoogleCalendarAuthError,
    );
  });
});

describe('token refresh (googleCalendarAuth.android)', () => {
  it('keeps a fresh token', async () => {
    storeTokens({ accessToken: 'old', expiresAt: Date.now() + 30 * 60_000, scopes: [] });
    await expect(
      refreshStoredGoogleCalendarToken({ clientId: 'c', googleSubject: 'sub-1' }),
    ).resolves.toMatchObject({ accessToken: 'old' });
    expect(mockAuthorizeGoogle).not.toHaveBeenCalled();
  });

  it('asks Play services again for the same account, without UI', async () => {
    storeTokens({ accessToken: 'old', expiresAt: 0, scopes: [], account: 'sam@example.com' });
    mockAuthorizeGoogle.mockResolvedValueOnce({
      accessToken: 'new',
      grantedScopes: CALENDAR_SCOPES,
    });

    await expect(
      refreshStoredGoogleCalendarToken({ clientId: 'c', googleSubject: 'sub-1' }),
    ).resolves.toMatchObject({ accessToken: 'new', account: 'sam@example.com' });

    expect(mockAuthorizeGoogle).toHaveBeenCalledWith(expect.any(Array), {
      account: 'sam@example.com',
      interactive: false,
    });
    expect(JSON.parse(mockStore.get('google-calendar.tokens.sub-1') ?? '{}').accessToken).toBe(
      'new',
    );
  });

  it('reports a removed grant as invalid_grant, which the sync reads as reconnect', async () => {
    storeTokens({ accessToken: 'old', expiresAt: 0, scopes: [], account: 'sam@example.com' });
    mockAuthorizeGoogle.mockRejectedValueOnce(codedError('CONSENT_REQUIRED'));
    await expect(
      refreshStoredGoogleCalendarToken({ clientId: 'c', googleSubject: 'sub-1' }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('revokes the token and clears it from Play services', async () => {
    const http = jest.fn(async () => ({ ok: true }) as Response);
    await revokeGoogleCalendarToken('tok', http);
    expect(http).toHaveBeenCalledWith('https://oauth2.googleapis.com/revoke?token=tok', {
      method: 'POST',
    });
    expect(mockClearGoogleToken).toHaveBeenCalledWith('tok');
  });
});
