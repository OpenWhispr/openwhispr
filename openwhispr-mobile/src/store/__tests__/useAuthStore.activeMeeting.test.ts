const mockSignOutApi = jest.fn();
const mockDeleteAccountApi = jest.fn();
const mockStopActiveMeeting = jest.fn();

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
jest.mock('@/lib/notes/activeMeeting', () => ({
  stopActiveMeeting: (...args: unknown[]) => mockStopActiveMeeting(...args),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ reset: jest.fn(), load: jest.fn() }) },
}));
jest.mock('@/services/agent/AgentComposerService', () => ({ clearAllSessions: jest.fn() }));
jest.mock('@/lib/chat/chatHistory', () => ({
  clearChatHistory: jest.fn(),
  stopChatTurn: jest.fn(),
}));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  clearProviderCredentials: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

import { Sentry } from '@/lib/sentry';
import { useAuthStore } from '@/store/useAuthStore';

beforeEach(() => {
  jest.clearAllMocks();
  mockSignOutApi.mockResolvedValue(undefined);
  mockDeleteAccountApi.mockResolvedValue(undefined);
  mockStopActiveMeeting.mockResolvedValue(undefined);
  useAuthStore.setState({
    user: { id: 'member', email: 'm@example.com', emailVerified: true, isAnonymous: false },
    sessionCookie: 'fixture-session',
    isGuest: false,
    isInitialized: true,
    isLoading: false,
    error: null,
  });
});

describe.each([
  ['signOut', mockSignOutApi],
  ['deleteAccount', mockDeleteAccountApi],
] as const)('%s with a meeting running', (action, api) => {
  it('stops the meeting before the API call', async () => {
    await useAuthStore.getState()[action]();
    expect(mockStopActiveMeeting.mock.invocationCallOrder[0]).toBeLessThan(
      api.mock.invocationCallOrder[0],
    );
  });

  it('still signs out when the stop rejects', async () => {
    const failure = new Error('stop failed');
    mockStopActiveMeeting.mockRejectedValue(failure);
    await useAuthStore.getState()[action]();
    expect(api).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(failure, expect.anything());
    expect(useAuthStore.getState().user).toBeNull();
  });
});
