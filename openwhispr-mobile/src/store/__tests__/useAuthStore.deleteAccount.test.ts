const mockDeleteAccountApi = jest.fn();
const mockSignOutApi = jest.fn();
const mockClearProviderCredentials = jest.fn();

jest.mock('@/lib/authClient', () => ({
  getStoredSession: jest.fn(),
  clearSession: jest.fn(),
  signInWithEmail: jest.fn(),
  signUpWithEmail: jest.fn(),
  signOut: (...args: unknown[]) => mockSignOutApi(...args),
  signInWithGoogle: jest.fn(),
  signInWithApple: jest.fn(),
  signInWithMicrosoft: jest.fn(),
  signInAnonymously: jest.fn(),
  deleteAccount: (...args: unknown[]) => mockDeleteAccountApi(...args),
  getSession: jest.fn(),
  initAuthenticatedUser: jest.fn(),
}));
jest.mock('@/lib/sentry', () => ({
  Sentry: { captureMessage: jest.fn(), captureException: jest.fn() },
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ reset: jest.fn(), load: jest.fn() }) },
}));
jest.mock('@/services/agent/AgentComposerService', () => ({ clearAllSessions: jest.fn() }));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  clearProviderCredentials: (...args: unknown[]) => mockClearProviderCredentials(...args),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

import { useAuthStore } from '@/store/useAuthStore';

const member = {
  id: 'member',
  email: 'member@example.com',
  emailVerified: true,
  isAnonymous: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockClearProviderCredentials.mockResolvedValue(undefined);
  mockDeleteAccountApi.mockResolvedValue(undefined);
  useAuthStore.setState({
    user: member,
    sessionCookie: 'fixture-session',
    isGuest: false,
    isInitialized: true,
    isLoading: false,
    error: null,
  });
});

it('erases provider keys once the account is deleted', async () => {
  await useAuthStore.getState().deleteAccount();
  expect(mockClearProviderCredentials).toHaveBeenCalledTimes(1);
  expect(mockDeleteAccountApi.mock.invocationCallOrder[0]).toBeLessThan(
    mockClearProviderCredentials.mock.invocationCallOrder[0],
  );
  expect(useAuthStore.getState().user).toBeNull();
});

it('keeps provider keys when the account could not be deleted', async () => {
  mockDeleteAccountApi.mockRejectedValue(new Error('Network request failed'));
  await expect(useAuthStore.getState().deleteAccount()).rejects.toThrow('Network request failed');
  expect(mockClearProviderCredentials).not.toHaveBeenCalled();
  expect(useAuthStore.getState()).toMatchObject({
    user: member,
    isLoading: false,
    error: 'Network request failed',
  });
});

it('finishes a completed deletion even if the keys cannot be erased', async () => {
  mockClearProviderCredentials.mockRejectedValue(new Error('Unable to clear provider credentials'));
  await useAuthStore.getState().deleteAccount();
  expect(useAuthStore.getState()).toMatchObject({ user: null, isLoading: false, error: null });
});

it('keeps provider keys when the user only signs out', async () => {
  await useAuthStore.getState().signOut();
  expect(mockClearProviderCredentials).not.toHaveBeenCalled();
});
