type AuthClientModule = typeof import('../authClient');

function loadAuthClient() {
  jest.resetModules();
  const result = {
    data: { user: { id: 'user-1', email: 'user@example.com', emailVerified: true } },
    error: null,
  };
  const client = {
    getCookie: jest.fn().mockReturnValue('better-auth.session_token=test-session.signature'),
    $store: { atoms: { session: { get: jest.fn(() => ({ data: null })) } } },
    signIn: {
      email: jest.fn().mockResolvedValue(result),
      anonymous: jest.fn().mockResolvedValue(result),
      social: jest.fn().mockResolvedValue(result),
    },
    signUp: { email: jest.fn().mockResolvedValue(result) },
  };
  const mockFetch = jest.fn().mockResolvedValue({ ok: true });
  jest.doMock('better-auth/client', () => ({ createAuthClient: () => client }));
  jest.doMock('better-auth/client/plugins', () => ({ anonymousClient: () => ({}) }));
  jest.doMock('@better-auth/expo/client', () => ({ expoClient: () => ({}) }));
  jest.doMock('expo-application', () => ({ applicationId: 'com.gizmolabs.openwhispr' }));
  jest.doMock('expo-constants', () => ({
    __esModule: true,
    default: { expoConfig: { scheme: 'openwhispr' } },
  }));
  const secureStore = { getItem: jest.fn(() => null) };
  jest.doMock('expo-secure-store', () => secureStore);
  jest.doMock('expo/fetch', () => ({ fetch: mockFetch }));
  jest.doMock('../apiClient', () => ({ getClientVersionHeader: () => ({}) }));

  return { auth: require('../authClient') as AuthClientModule, client, mockFetch, secureStore };
}

afterEach(() => jest.resetModules());

it.each([
  [
    'email sign-in',
    (auth: AuthClientModule) => auth.signInWithEmail('user@example.com', 'password'),
  ],
  ['sign-up', (auth: AuthClientModule) => auth.signUpWithEmail('user@example.com', 'password')],
  ['anonymous sign-in', (auth: AuthClientModule) => auth.signInAnonymously()],
  ['Google sign-in', (auth: AuthClientModule) => auth.signInWithGoogle()],
  ['Apple sign-in', (auth: AuthClientModule) => auth.signInWithApple()],
  ['Microsoft sign-in', (auth: AuthClientModule) => auth.signInWithMicrosoft()],
] as const)('%s returns the resolved session cookie', async (_name, signIn) => {
  const { auth } = loadAuthClient();

  await expect(signIn(auth)).resolves.toMatchObject({
    sessionCookie: 'better-auth.session_token=test-session.signature',
    error: null,
  });
});

it.each([null, ''])('treats an empty stored cookie (%s) as no session', async (cookie) => {
  const { auth, client } = loadAuthClient();
  client.getCookie.mockResolvedValue(cookie);

  await expect(auth.getStoredSession()).resolves.toBeNull();
});

it('sends the resolved cookie when deleting the account', async () => {
  const { auth, mockFetch } = loadAuthClient();

  await auth.deleteAccount();

  expect(mockFetch).toHaveBeenCalledWith(
    expect.stringContaining('/api/auth/delete-account'),
    expect.objectContaining({
      method: 'DELETE',
      headers: expect.objectContaining({
        Cookie: 'better-auth.session_token=test-session.signature',
      }),
    }),
  );
});

it('refuses account deletion without a stored cookie before making a request', async () => {
  const { auth, client, mockFetch } = loadAuthClient();
  client.getCookie.mockResolvedValue(null);

  await expect(auth.deleteAccount()).rejects.toThrow('Not authenticated');
  expect(mockFetch).not.toHaveBeenCalled();
});

describe('cached capture identity', () => {
  function cachedSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      user: { id: 'user-1', email: 'user@example.com', emailVerified: true },
      session: {
        id: 'session-1',
        userId: 'user-1',
        token: 'test-session',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      ...overrides,
    };
  }

  it.each([
    'better-auth.session_token=test-session.signature',
    '__Secure-better-auth.session_token=test-session.signature%2Bencoded%3D',
  ])('reads the SDK cached session synchronously for %s', (cookie) => {
    const { auth, client, mockFetch } = loadAuthClient();
    client.$store.atoms.session.get.mockReturnValue({ data: cachedSession() } as never);
    client.getCookie.mockReturnValue(cookie);

    expect(auth.getCachedSession()).toEqual({
      user: { id: 'user-1', email: 'user@example.com', emailVerified: true, isAnonymous: false },
      sessionCookie: cookie,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', null],
    [
      'expired',
      cachedSession({
        session: {
          id: 'session-1',
          userId: 'user-1',
          token: 'test-session',
          expiresAt: '2000-01-01T00:00:00.000Z',
        },
      }),
    ],
    [
      'mismatched owner',
      cachedSession({
        session: {
          id: 'session-1',
          userId: 'other-user',
          token: 'test-session',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      }),
    ],
    [
      'mismatched cookie',
      cachedSession({
        session: {
          id: 'session-1',
          userId: 'user-1',
          token: 'other-session',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      }),
    ],
  ])('excludes %s cached sessions', (_name, data) => {
    const { auth, client } = loadAuthClient();
    client.$store.atoms.session.get.mockReturnValue({ data } as never);
    expect(auth.getCachedSession()).toBeNull();
  });

  it('excludes persisted guest sessions and cleared cookies', () => {
    const { auth, client, secureStore } = loadAuthClient();
    client.$store.atoms.session.get.mockReturnValue({ data: cachedSession() } as never);
    secureStore.getItem.mockReturnValue('true' as never);
    expect(auth.getCachedSession()).toBeNull();
    secureStore.getItem.mockReturnValue(null);
    client.getCookie.mockReturnValue('');
    expect(auth.getCachedSession()).toBeNull();
  });

  it('retains the anonymous marker and fails closed when secure storage is unavailable', () => {
    const { auth, client, secureStore } = loadAuthClient();
    client.$store.atoms.session.get.mockReturnValue({
      data: cachedSession({ user: { id: 'user-1', email: 'guest@anon.openwhispr.invalid' } }),
    } as never);
    expect(auth.getCachedSession()?.user?.isAnonymous).toBe(true);
    secureStore.getItem.mockImplementation(() => {
      throw new Error('Keychain unavailable');
    });
    expect(auth.getCachedSession()).toBeNull();
  });
});
