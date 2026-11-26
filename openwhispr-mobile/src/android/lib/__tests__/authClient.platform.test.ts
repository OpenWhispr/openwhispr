const mockCreate = jest.fn((_options: unknown) => ({
  getCookie: jest.fn(),
  getSession: jest.fn(),
}));
const mockExpo = jest.fn((_options: unknown) => ({}));
const mockDelete = jest.fn(async (_key: string) => {});
const mockWrite = jest.fn(async (_key: string, _value: string) => {});
jest.mock('better-auth/client', () => ({
  createAuthClient: (...args: Parameters<typeof mockCreate>) => mockCreate(...args),
}));
jest.mock('better-auth/client/plugins', () => ({ anonymousClient: () => ({}) }));
jest.mock('@better-auth/expo/client', () => ({
  expoClient: (...args: Parameters<typeof mockExpo>) => mockExpo(...args),
  storageAdapter: () => ({ setItemAsync: mockWrite }),
}));
jest.mock('expo-application', () => ({ applicationId: 'com.gizmolabs.openwhispr' }));
jest.mock('expo-constants', () => ({ expoConfig: { scheme: 'openwhispr' } }));
jest.mock('expo-secure-store', () => ({
  deleteItemAsync: (...args: Parameters<typeof mockDelete>) => mockDelete(...args),
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('@/lib/apiClient', () => ({ getClientVersionHeader: () => ({}) }));
jest.mock('@/android/lib/apiClient', () => jest.requireMock('@/lib/apiClient'));

const { clearSession } = require('@/lib/authClient') as typeof import('@/lib/authClient');

it('keeps default SDK setup to the origin headers, free of Android response and cookie overrides', () => {
  // Only the origin headers from main (#3088); no Android response hook.
  expect((mockCreate.mock.calls[0]?.[0] as { fetchOptions?: unknown })?.fetchOptions).toEqual({
    headers: { 'x-openwhispr-source': 'mobile', 'x-openwhispr-os': 'ios' },
  });
  expect(mockExpo.mock.calls[0]?.[0]).not.toHaveProperty('cookiePrefix');
});

it('clears the default session through the upstream secure-store deletion API', async () => {
  await clearSession();
  expect(mockDelete.mock.calls).toEqual([['openwhispr_cookie'], ['openwhispr_session_data']]);
  expect(mockWrite).not.toHaveBeenCalled();
});
