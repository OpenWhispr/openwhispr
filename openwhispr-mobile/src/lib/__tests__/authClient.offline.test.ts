const mockGetSession = jest.fn();
const mockGetCookie = jest.fn();
const mockReadCache = jest.fn();
const mockDeleteCache = jest.fn();

jest.mock('better-auth/client', () => ({
  createAuthClient: () => ({
    getSession: (...args: unknown[]) => mockGetSession(...args),
    getCookie: () => mockGetCookie(),
  }),
}));
jest.mock('better-auth/client/plugins', () => ({ anonymousClient: () => ({}) }));
jest.mock('@better-auth/expo/client', () => ({
  expoClient: () => ({}),
  storageAdapter: () => ({ getItem: (...args: unknown[]) => mockReadCache(...args) }),
}));
jest.mock('expo-application', () => ({ applicationId: 'com.gizmolabs.openwhispr.dev' }));
jest.mock('expo-constants', () => ({ expoConfig: { scheme: 'openwhispr-dev' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: (...args: unknown[]) => mockReadCache(...args),
  deleteItemAsync: (...args: unknown[]) => mockDeleteCache(...args),
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../apiClient', () => ({ getClientVersionHeader: () => 'test' }));

import { Platform } from 'react-native';
import { getSession } from '../authClient';

const originalPlatform = Platform.OS;
const user = {
  id: 'saved-user',
  email: 'saved@example.com',
  emailVerified: true,
  isAnonymous: false,
};
const cachedSession = () => ({
  user,
  session: {
    id: 'saved-session',
    userId: user.id,
    token: 'dummy-test-token',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
});

beforeEach(() => {
  jest.resetAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  mockGetCookie.mockReturnValue('__Secure-better-auth.session_token=dummy-test-token.signature');
  mockReadCache.mockReturnValue(JSON.stringify(cachedSession()));
  mockDeleteCache.mockResolvedValue(undefined);
  mockGetSession.mockRejectedValue(new TypeError('Network request failed'));
});
afterAll(() => Object.defineProperty(Platform, 'OS', { value: originalPlatform }));

it.each(['better-auth', 'openwhispr'])(
  'restores a matching unexpired %s session during an outage',
  async (prefix) => {
    mockGetCookie.mockReturnValue(`__Secure-${prefix}.session_token=dummy-test-token.signature`);
    expect(await getSession({ allowOfflineCache: true })).toEqual(user);
    expect(mockReadCache).toHaveBeenCalledWith('openwhispr_session_data');
  },
);

it('allows transient server failure but never substitutes cache for a rejected session', async () => {
  mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 503 } });
  expect(await getSession({ allowOfflineCache: true })).toEqual(user);
  mockGetSession.mockResolvedValueOnce({ data: null, error: { status: 401 } });
  expect(await getSession({ allowOfflineCache: true })).toBeNull();
  expect(mockDeleteCache).toHaveBeenCalledWith('openwhispr_session_data');
});

it('clears stale cached identity after an authoritative signed-out response', async () => {
  mockGetSession.mockResolvedValue({ data: null, error: null });
  expect(await getSession({ allowOfflineCache: true })).toBeNull();
  expect(mockDeleteCache).toHaveBeenCalledWith('openwhispr_session_data');
});

it.each([
  'expired',
  'different-cookie',
  'missing-cookie',
  'different-user',
  'malformed',
  'unrecognized-cookie',
  'ambiguous-cookie',
  'malformed-cookie',
])('does not restore a %s cache', async (scenario) => {
  const cache = cachedSession();
  if (scenario === 'expired') cache.session.expiresAt = new Date(Date.now() - 1).toISOString();
  if (scenario === 'different-cookie')
    mockGetCookie.mockReturnValue('better-auth.session_token=other.signature');
  if (scenario === 'missing-cookie') mockGetCookie.mockReturnValue(null);
  if (scenario === 'unrecognized-cookie')
    mockGetCookie.mockReturnValue('unknown.session_token=dummy-test-token.signature');
  if (scenario === 'ambiguous-cookie')
    mockGetCookie.mockReturnValue(
      'openwhispr.session_token=dummy-test-token.signature; better-auth.session_token=other.signature',
    );
  if (scenario === 'malformed-cookie')
    mockGetCookie.mockReturnValue('openwhispr.session_token=%invalid');
  if (scenario === 'different-user') cache.session.userId = 'another-user';
  mockReadCache.mockReturnValue(scenario === 'malformed' ? '{' : JSON.stringify(cache));
  expect(await getSession({ allowOfflineCache: true })).toBeNull();
});

it('does not use cache for explicit sign-in validation or for iOS', async () => {
  await expect(getSession()).rejects.toThrow('Network request failed');
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  await expect(getSession({ allowOfflineCache: true })).rejects.toThrow('Network request failed');
  expect(mockReadCache).not.toHaveBeenCalled();
});

it('uses the current server identity when online', async () => {
  const current = { ...user, id: 'current-user' };
  mockGetSession.mockResolvedValue({ data: { user: current }, error: null });
  expect(await getSession({ allowOfflineCache: true })).toEqual(current);
  expect(mockReadCache).not.toHaveBeenCalled();
});

it('rejects cached identity if the cookie changes while storage is read', async () => {
  mockReadCache.mockImplementation(() => {
    mockGetCookie.mockReturnValue('better-auth.session_token=another-login.signature');
    return JSON.stringify(cachedSession());
  });
  expect(await getSession({ allowOfflineCache: true })).toBeNull();
});

it('forgets cached identity when the session request throws an authoritative rejection', async () => {
  mockGetSession.mockRejectedValue({ status: 403 });
  await expect(getSession({ allowOfflineCache: true })).rejects.toEqual({ status: 403 });
  expect(mockDeleteCache).toHaveBeenCalledWith('openwhispr_session_data');
});
