interface AuthClientOptions {
  fetchOptions?: { headers?: Record<string, string> };
}

function loadAuthClientOptions(os: 'ios' | 'android'): AuthClientOptions {
  jest.resetModules();
  let captured: AuthClientOptions = {};
  jest.doMock('better-auth/client', () => ({
    createAuthClient: (options: AuthClientOptions) => {
      captured = options;
      return {};
    },
  }));
  jest.doMock('better-auth/client/plugins', () => ({ anonymousClient: () => ({}) }));
  jest.doMock('@better-auth/expo/client', () => ({ expoClient: () => ({}) }));
  jest.doMock('expo-application', () => ({ applicationId: 'com.gizmolabs.openwhispr' }));
  jest.doMock('expo-constants', () => ({
    __esModule: true,
    default: { expoConfig: { scheme: 'openwhispr' } },
  }));
  jest.doMock('expo-secure-store', () => ({}));
  jest.doMock('expo/fetch', () => ({ fetch: jest.fn() }));
  jest.doMock('react-native', () => ({ Platform: { OS: os } }));
  jest.doMock('../apiClient', () => ({ getClientVersionHeader: () => ({}) }));

  require('../authClient');
  return captured;
}

afterEach(() => jest.resetModules());

// The API records these as the origin of an account the app creates, and keeps
// them through the browser OAuth flow in its server-held state.
it.each(['ios', 'android'] as const)(
  'declares the mobile app on %s to every auth request',
  (os) => {
    expect(loadAuthClientOptions(os).fetchOptions?.headers).toEqual({
      'x-openwhispr-source': 'mobile',
      'x-openwhispr-os': os,
    });
  },
);
