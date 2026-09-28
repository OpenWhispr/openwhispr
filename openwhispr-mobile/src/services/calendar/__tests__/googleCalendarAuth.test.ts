import { Buffer } from 'buffer';
import {
  decodeGoogleIdToken,
  deleteGoogleCalendarTokens,
  getGoogleCalendarTokens,
  hasRequiredGoogleCalendarScopes,
  refreshStoredGoogleCalendarToken,
  saveGoogleCalendarTokens,
  buildGoogleCalendarAuthRequest,
  GoogleCalendarAuthError,
  type GoogleCalendarTokenBundle,
} from '../googleCalendarAuth';
import { getGoogleCalendarRequiredScopes } from '../googleCalendarConfig';

class MemorySecureStore {
  private readonly values = new Map<string, string>();

  async getItemAsync(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItemAsync(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async deleteItemAsync(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const jsonResponse = (ok: boolean, status: number, body: unknown): Response =>
  ({
    ok,
    status,
    json: async () => body,
  }) as Response;

const token = (overrides: Partial<GoogleCalendarTokenBundle> = {}): GoogleCalendarTokenBundle => ({
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  idToken: 'id-token',
  expiresAt: Date.now() + 3600_000,
  scopes: getGoogleCalendarRequiredScopes(),
  ...overrides,
});

const base64Url = (value: unknown): string =>
  Buffer.from(JSON.stringify(value))
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

describe('googleCalendarAuth', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('validates required Google Calendar scopes', () => {
    expect(hasRequiredGoogleCalendarScopes(getGoogleCalendarRequiredScopes())).toBe(true);
    expect(hasRequiredGoogleCalendarScopes('openid email')).toBe(false);
  });

  it('accepts the canonical identity scope forms Google returns and only requires calendar scopes', () => {
    expect(
      hasRequiredGoogleCalendarScopes([
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/calendar.events.readonly',
        'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      ]),
    ).toBe(true);
  });

  it('rejects when a required calendar scope is missing', () => {
    expect(
      hasRequiredGoogleCalendarScopes([
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ]),
    ).toBe(false);
  });

  it('requests consent and account chooser for multi-account device testing', () => {
    const previousRedirectUri = process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_URI;
    process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_URI = 'com.example:/oauth2redirect';
    try {
      const request = buildGoogleCalendarAuthRequest('client-id') as unknown as {
        extraParams?: Record<string, string>;
      };

      expect(request.extraParams?.prompt).toBe('consent select_account');
    } finally {
      process.env.EXPO_PUBLIC_GOOGLE_CALENDAR_IOS_REDIRECT_URI = previousRedirectUri;
    }
  });

  it('decodes stable identity claims from a Google ID token', () => {
    const idToken = `${base64Url({ alg: 'none' })}.${base64Url({
      sub: 'google-sub-1',
      email: 'person@example.com',
      name: 'Person',
    })}.signature`;

    expect(decodeGoogleIdToken(idToken)).toEqual({
      sub: 'google-sub-1',
      email: 'person@example.com',
      name: 'Person',
    });
  });

  it('saves, reads, and deletes tokens keyed by Google subject', async () => {
    const storage = new MemorySecureStore();
    const stored = token();
    await saveGoogleCalendarTokens('google-sub-1', stored, storage);

    expect(await getGoogleCalendarTokens('google-sub-1', storage)).toEqual(stored);

    await deleteGoogleCalendarTokens('google-sub-1', storage);
    expect(await getGoogleCalendarTokens('google-sub-1', storage)).toBeNull();
  });

  it('returns fresh stored access tokens without refreshing', async () => {
    const storage = new MemorySecureStore();
    const stored = token({ accessToken: 'fresh-access' });
    await saveGoogleCalendarTokens('google-sub-1', stored, storage);
    const httpClient = jest.fn();

    await expect(
      refreshStoredGoogleCalendarToken(
        { clientId: 'client-id', googleSubject: 'google-sub-1' },
        { storage, httpClient },
      ),
    ).resolves.toEqual(stored);
    expect(httpClient).not.toHaveBeenCalled();
  });

  it('refreshes expired tokens and preserves the refresh token when Google omits it', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const storage = new MemorySecureStore();
    await saveGoogleCalendarTokens(
      'google-sub-1',
      token({ accessToken: 'expired-access', expiresAt: 1 }),
      storage,
    );
    const httpClient = jest.fn().mockResolvedValue(
      jsonResponse(true, 200, {
        access_token: 'new-access',
        expires_in: 3600,
        scope: getGoogleCalendarRequiredScopes().join(' '),
      }),
    );

    const refreshed = await refreshStoredGoogleCalendarToken(
      { clientId: 'client-id', googleSubject: 'google-sub-1' },
      { storage, httpClient },
    );

    expect(refreshed).toEqual(
      expect.objectContaining({
        accessToken: 'new-access',
        refreshToken: 'refresh-token',
        expiresAt: 1_000_000 + 3600_000,
      }),
    );
    expect(await getGoogleCalendarTokens('google-sub-1', storage)).toEqual(refreshed);
  });

  it('refreshes expired tokens using stored scopes when Google omits unchanged scope', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const storage = new MemorySecureStore();
    await saveGoogleCalendarTokens(
      'google-sub-1',
      token({ accessToken: 'expired-access', expiresAt: 1 }),
      storage,
    );
    const httpClient = jest.fn().mockResolvedValue(
      jsonResponse(true, 200, {
        access_token: 'new-access-without-scope',
        expires_in: 3600,
      }),
    );

    const refreshed = await refreshStoredGoogleCalendarToken(
      { clientId: 'client-id', googleSubject: 'google-sub-1' },
      { storage, httpClient },
    );

    expect(refreshed).toEqual(
      expect.objectContaining({
        accessToken: 'new-access-without-scope',
        refreshToken: 'refresh-token',
        scopes: getGoogleCalendarRequiredScopes(),
      }),
    );
    expect(await getGoogleCalendarTokens('google-sub-1', storage)).toEqual(refreshed);
  });

  it('surfaces invalid_grant so callers can mark accounts needs_reconnect', async () => {
    const storage = new MemorySecureStore();
    await saveGoogleCalendarTokens(
      'google-sub-1',
      token({ accessToken: 'expired-access', expiresAt: 1 }),
      storage,
    );
    const httpClient = jest.fn().mockResolvedValue(
      jsonResponse(false, 400, {
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      }),
    );

    await expect(
      refreshStoredGoogleCalendarToken(
        { clientId: 'client-id', googleSubject: 'google-sub-1' },
        { storage, httpClient },
      ),
    ).rejects.toMatchObject({
      code: 'invalid_grant',
      message: 'Token has been expired or revoked.',
    } satisfies Partial<GoogleCalendarAuthError>);
  });
});
