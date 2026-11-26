jest.mock('@/android/accountData', () => ({
  prepareAccountData: jest.fn(),
  retryAccountDataDeletion: async () => {},
}));
jest.mock('@/lib/authClient', () => ({
  getStoredSession: jest.fn(),
  clearSession: jest.fn(),
  signInWithEmail: jest.fn(),
  signUpWithEmail: jest.fn(),
  signOut: jest.fn(),
  signInWithGoogle: jest.fn(),
  signInWithApple: jest.fn(),
  signInWithMicrosoft: jest.fn(),
  signInAnonymously: jest.fn(),
  deleteAccount: jest.fn(),
  getSession: jest.fn(),
  initAuthenticatedUser: jest.fn(),
}));
jest.mock('@/android/lib/authClient', () => jest.requireMock('@/lib/authClient'));
jest.mock('@/lib/sentry', () => ({
  Sentry: { captureMessage: jest.fn(), captureException: jest.fn() },
}));
jest.mock('@/android/lib/sentry', () => jest.requireMock('@/lib/sentry'));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ reset: jest.fn(), load: jest.fn() }) },
}));
jest.mock('@/android/store/useUsageStore', () => jest.requireMock('@/store/useUsageStore'));
jest.mock('@/services/agent/AgentComposerService', () => ({ clearAllSessions: jest.fn() }));
jest.mock('@/lib/chat/chatHistory', () => ({
  clearChatHistory: jest.fn(),
  stopChatTurn: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

import { useAuthStore as useAndroidAuthStore } from '@/android/store/useAuthStore';
import { signInWithApple, signInWithGoogle, signInWithMicrosoft } from '@/lib/authClient';

// The sign-in spinner fix (#3229) is Android's; iOS keeps main's store.
const stores = [['android', useAndroidAuthStore]] as const;
const providers = [
  ['google', 'signInWithGoogle', signInWithGoogle],
  ['apple', 'signInWithApple', signInWithApple],
  ['microsoft', 'signInWithMicrosoft', signInWithMicrosoft],
] as const;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const [, store] of stores) {
    store.setState({
      user: null,
      sessionCookie: null,
      isGuest: false,
      isInitialized: true,
      isLoading: false,
      loadingProvider: null,
      error: null,
    });
  }
});

afterEach(() => {
  jest.mocked(console.warn).mockRestore();
});

describe.each(stores)('%s store', (_platform, store) => {
  it.each(providers)(
    'clears the %s button and shows an error when sign-in throws',
    async (_provider, action, api) => {
      jest.mocked(api).mockRejectedValue(new TypeError('Network request failed'));

      await expect(store.getState()[action]()).resolves.toBeUndefined();

      expect(store.getState()).toMatchObject({
        isLoading: false,
        loadingProvider: null,
        user: null,
        error: 'Sign in failed. Check your connection and try again.',
      });
    },
  );

  it('keeps the returned error for a sign-in that fails without throwing', async () => {
    jest
      .mocked(signInWithGoogle)
      .mockResolvedValue({ success: false, sessionCookie: null, error: 'OAuth failed' });

    await store.getState().signInWithGoogle();

    expect(store.getState()).toMatchObject({
      isLoading: false,
      loadingProvider: null,
      error: 'OAuth failed',
    });
  });
});
