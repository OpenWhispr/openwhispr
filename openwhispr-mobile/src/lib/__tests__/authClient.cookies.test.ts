type AuthClientModule = typeof import('../authClient');

function loadAuthClient() {
  jest.resetModules();
  const result = {
    data: { user: { id: 'user-1', email: 'user@example.com', emailVerified: true } },
    error: null,
  };
  const client = {
    getCookie: jest.fn().mockResolvedValue('better-auth.session_token=test-session'),
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
  jest.doMock('expo-secure-store', () => ({}));
  jest.doMock('expo/fetch', () => ({ fetch: mockFetch }));
  jest.doMock('../apiClient', () => ({ getClientVersionHeader: () => ({}) }));

  return { auth: require('../authClient') as AuthClientModule, client, mockFetch };
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
    sessionCookie: 'better-auth.session_token=test-session',
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
      headers: expect.objectContaining({ Cookie: 'better-auth.session_token=test-session' }),
    }),
  );
});

it('refuses account deletion without a stored cookie before making a request', async () => {
  const { auth, client, mockFetch } = loadAuthClient();
  client.getCookie.mockResolvedValue(null);

  await expect(auth.deleteAccount()).rejects.toThrow('Not authenticated');
  expect(mockFetch).not.toHaveBeenCalled();
});
