const mockSignInAnonymously = jest.fn();
const mockCaptureMessage = jest.fn();

jest.mock('@/lib/authClient', () => ({
  getStoredSession: jest.fn(),
  clearSession: jest.fn(),
  signInWithEmail: jest.fn(),
  signUpWithEmail: jest.fn(),
  signOut: jest.fn(),
  signInWithGoogle: jest.fn(),
  signInWithApple: jest.fn(),
  signInWithMicrosoft: jest.fn(),
  signInAnonymously: (...args: unknown[]) => mockSignInAnonymously(...args),
  deleteAccount: jest.fn(),
  getSession: jest.fn(),
  initAuthenticatedUser: jest.fn(),
}));
jest.mock('@/lib/sentry', () => ({
  Sentry: {
    captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
    captureException: jest.fn(),
  },
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ reset: jest.fn(), load: jest.fn() }) },
}));
jest.mock('@/services/agent/AgentComposerService', () => ({ clearAllSessions: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

import { useAuthStore } from '@/store/useAuthStore';

const anonymousUser = {
  id: 'anon-user',
  email: 'temp-1@anon.openwhispr.invalid',
  emailVerified: false,
  isAnonymous: true,
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({
    user: null,
    sessionCookie: null,
    isGuest: false,
    isInitialized: true,
    isLoading: false,
    error: null,
  });
  mockSignInAnonymously.mockResolvedValue({
    user: anonymousUser,
    sessionCookie: 'session=anon',
    error: null,
    status: null,
  });
});

describe('useAuthStore.ensureAnonymousSession', () => {
  it('opens a session and stores it as a signed-in, non-guest user', async () => {
    await useAuthStore.getState().ensureAnonymousSession();

    expect(useAuthStore.getState().user).toEqual(anonymousUser);
    expect(useAuthStore.getState().sessionCookie).toBe('session=anon');
    expect(useAuthStore.getState().isGuest).toBe(false);
  });

  // Every extra request would leave an orphaned user row on the server.
  it('folds concurrent attempts into one request', async () => {
    const gate = deferred<{
      user: typeof anonymousUser;
      sessionCookie: string;
      error: null;
      status: null;
    }>();
    mockSignInAnonymously.mockReturnValueOnce(gate.promise);

    const first = useAuthStore.getState().ensureAnonymousSession();
    const second = useAuthStore.getState().ensureAnonymousSession();
    gate.resolve({ user: anonymousUser, sessionCookie: 'session=anon', error: null, status: null });
    await Promise.all([first, second]);

    expect(mockSignInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('leaves a guest alone', async () => {
    useAuthStore.setState({ isGuest: true });

    await useAuthStore.getState().ensureAnonymousSession();

    expect(mockSignInAnonymously).not.toHaveBeenCalled();
  });

  // A refusal the server actually sent — route missing after a bad deploy,
  // plugin off, rate limited — is systematic and has to be loud.
  it('reports a refusal the server sent at error level', async () => {
    mockSignInAnonymously.mockResolvedValue({
      user: null,
      sessionCookie: null,
      error: 'Not found',
      status: 404,
    });

    await useAuthStore.getState().ensureAnonymousSession();

    expect(useAuthStore.getState().user).toBeNull();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Anonymous session could not be created',
      expect.objectContaining({ level: 'error' }),
    );
  });

  // No response is the offline-at-first-launch case the foreground retry
  // exists for; filing it as an outage would drown the real ones.
  it('reports a request that got no response as a warning', async () => {
    mockSignInAnonymously.mockResolvedValue({
      user: null,
      sessionCookie: null,
      error: 'Network request failed',
      status: null,
    });

    await useAuthStore.getState().ensureAnonymousSession();

    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'Anonymous session could not be created',
      expect.objectContaining({ level: 'warning' }),
    );
  });
});

it('does not recreate an anonymous session after the user explicitly chooses guest mode', async () => {
  const gate = deferred<{
    user: typeof anonymousUser;
    sessionCookie: string;
    error: null;
    status: null;
  }>();
  mockSignInAnonymously.mockReturnValueOnce(gate.promise);
  const signingIn = useAuthStore.getState().ensureAnonymousSession();
  const guest = useAuthStore.getState().continueAsGuest();
  await Promise.resolve();
  gate.resolve({ user: anonymousUser, sessionCookie: 'session=anon', error: null, status: null });
  await Promise.all([signingIn, guest]);
  expect(useAuthStore.getState()).toMatchObject({ user: null, sessionCookie: null, isGuest: true });
});

it('still enters guest mode if the anonymous request fails while guest mode is waiting', async () => {
  let rejectSignIn!: (error: Error) => void;
  mockSignInAnonymously.mockReturnValueOnce(
    new Promise((_, reject) => {
      rejectSignIn = reject;
    }),
  );
  const signingIn = useAuthStore
    .getState()
    .ensureAnonymousSession()
    .catch((error: unknown) => error);
  const guest = useAuthStore.getState().continueAsGuest();
  rejectSignIn(new Error('offline'));
  expect(await signingIn).toMatchObject({ message: 'offline' });
  await guest;
  expect(useAuthStore.getState()).toMatchObject({
    user: null,
    sessionCookie: null,
    isGuest: true,
    isLoading: false,
  });
});
