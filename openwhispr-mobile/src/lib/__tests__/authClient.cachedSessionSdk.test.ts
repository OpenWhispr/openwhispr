import type { CachedSession } from '../authClient';

type ExpoSdk = typeof import('@better-auth/expo/client');

function loadSdkFixture(): {
  auth: typeof import('../authClient');
  sdk: ExpoSdk;
  storage: Parameters<ExpoSdk['storageAdapter']>[0];
  values: Map<string, string>;
  atom: { get: jest.Mock; set: jest.Mock };
  network: jest.Mock;
} {
  jest.resetModules();
  const values = new Map<string, string>();
  const storage = {
    getItem: jest.fn((key: string): string | null => values.get(key) ?? null),
    getItemAsync: jest.fn(async (key: string): Promise<string | null> => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string): void => {
      values.set(key, value);
    }),
    setItemAsync: jest.fn(async (key: string, value: string): Promise<void> => {
      values.set(key, value);
    }),
  };
  const atom = { get: jest.fn(() => ({ data: null })), set: jest.fn() };
  const network = jest.fn(() => {
    throw new Error('Capture must not request a network session');
  });
  // Execute the installed Expo SDK's plugin and storage adapter; only its host client/native IO
  // and imports used for network/OAuth hooks are replaced. A handwritten getCookie mock would
  // miss the async contract and cache-hydration change that caused the CI failure.
  jest.doMock('better-auth/client', () => ({
    createAuthClient: ({
      plugins,
    }: {
      plugins: { id: string; getActions?: ReturnType<ExpoSdk['expoClient']>['getActions'] }[];
    }) => {
      const plugin = plugins.find((candidate) => candidate.id === 'expo')!;
      const actions = plugin.getActions!(undefined, { atoms: { session: atom } } as never);
      return { ...actions, getSession: network };
    },
    kFocusManager: Symbol('focus'),
    kOnlineManager: Symbol('online'),
  }));
  jest.doMock('better-auth/client/plugins', () => ({
    anonymousClient: () => ({ id: 'anonymous' }),
  }));
  jest.doMock('@better-auth/core/utils/json', () => ({ safeJSONParse: JSON.parse }));
  jest.doMock('@better-auth/core/env', () => ({ logger: { error: jest.fn() } }));
  jest.doMock('better-auth/cookies/utils', () => ({}));
  jest.doMock('expo-secure-store', () => storage);
  jest.doMock('expo-application', () => ({ applicationId: 'com.gizmolabs.openwhispr' }));
  jest.doMock('expo-constants', () => ({
    __esModule: true,
    default: { expoConfig: { scheme: 'openwhispr' } },
  }));
  jest.doMock('expo/fetch', () => ({ fetch: network }));
  jest.doMock('../apiClient', () => ({ getClientVersionHeader: () => ({}) }));
  jest.dontMock('@better-auth/expo/client');
  return {
    auth: require('../authClient') as typeof import('../authClient'),
    sdk: jest.requireActual('@better-auth/expo/client') as ExpoSdk,
    storage,
    values,
    atom,
    network,
  };
}

afterEach(() => jest.resetModules());

it('reads a chunked local session with the installed async SDK while its session atom is still empty', async () => {
  const { auth, sdk, storage, values, atom, network } = loadSdkFixture();
  const adapter = sdk.storageAdapter(storage);
  const user = {
    id: 'cached-account',
    email: 'person@example.com',
    name: 'Long name '.repeat(250),
    emailVerified: true,
    isAnonymous: false,
  };
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await adapter.setItemAsync(
    'openwhispr_session_data',
    JSON.stringify({
      user,
      session: { id: 'cached-session', userId: user.id, token: 'cached-token', expiresAt },
    }),
  );
  await adapter.setItemAsync(
    'openwhispr_cookie',
    JSON.stringify({
      '__Secure-better-auth.session_token': {
        value: 'cached-token.signature%2Bencoded%3D',
        expires: expiresAt,
      },
    }),
  );
  expect(values.get('openwhispr_session_data')).toContain('ba-chunks:');
  expect(atom.get().data).toBeNull();

  const pending = auth.getCachedSession();
  expect(pending).toBeInstanceOf(Promise);
  await expect(pending).resolves.toEqual({
    user,
    sessionCookie: '__Secure-better-auth.session_token=cached-token.signature%2Bencoded%3D',
  } satisfies CachedSession);
  expect(atom.set).not.toHaveBeenCalled();
  expect(network).not.toHaveBeenCalled();
});

it('does not combine a cached account with a different asynchronously read session cookie', async () => {
  const { auth, sdk, storage, network } = loadSdkFixture();
  const adapter = sdk.storageAdapter(storage);
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await adapter.setItemAsync(
    'openwhispr_session_data',
    JSON.stringify({
      user: { id: 'old-account', email: 'old@example.com' },
      session: { id: 'old-session', userId: 'old-account', token: 'old-token', expiresAt },
    }),
  );
  await adapter.setItemAsync(
    'openwhispr_cookie',
    JSON.stringify({
      'better-auth.session_token': { value: 'new-token.signature', expires: expiresAt },
    }),
  );
  await expect(auth.getCachedSession()).resolves.toBeNull();
  expect(network).not.toHaveBeenCalled();
});
