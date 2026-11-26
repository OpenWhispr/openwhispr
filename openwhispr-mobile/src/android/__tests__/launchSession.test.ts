// Decisions F3 and F4: Android opens on the saved session and checks it behind Home; an ended
// session keeps its account's workspace and shows "You've been signed out" once.
const mockPrepareAccountData = jest.fn();
jest.mock('@/android/accountData', () => ({
  prepareAccountData: (...args: unknown[]) => mockPrepareAccountData(...args),
  retryAccountDataDeletion: async () => {},
}));
const mockGetStoredSession = jest.fn();
jest.mock('@/lib/authClient', () => ({
  getStoredSession: () => mockGetStoredSession(),
  getSession: jest.fn(),
  clearSession: jest.fn(),
  signInWithEmail: jest.fn(),
  signUpWithEmail: jest.fn(),
  signOut: jest.fn(),
  signInWithGoogle: jest.fn(),
  signInWithApple: jest.fn(),
  signInWithMicrosoft: jest.fn(),
  signInAnonymously: jest.fn(),
  deleteAccount: jest.fn(),
  initAuthenticatedUser: jest.fn(),
}));
const mockReadSavedSession = jest.fn();
const mockCheckSession = jest.fn();
jest.mock('@/lib/authClient.android', () => ({
  readSavedSession: () => mockReadSavedSession(),
  checkSession: (timeout: number) => mockCheckSession(timeout),
}));
jest.mock('@/lib/notes/noteShareTokens', () => ({
  claimNoteShareTokens: async () => {},
  clearNoteShareTokens: async () => {},
}));
jest.mock('@/lib/sentry', () => ({
  Sentry: { captureMessage: jest.fn(), captureException: jest.fn() },
}));
jest.mock('@/store/useUsageStore', () => {
  const { create } = require('zustand');
  const store = create(() => ({ usage: null, sessionRejected: false }));
  store.setState({ reset: () => store.setState({ usage: null, sessionRejected: false }) });
  return { useUsageStore: store };
});
jest.mock('@/android/store/useUsageStore', () => jest.requireMock('@/store/useUsageStore'));
jest.mock('@/store/useUsageStore.android', () => require('@/store/useUsageStore'));
jest.mock('@/store/useAuthStore', () => jest.requireActual('@/store/useAuthStore.android'));
jest.mock('@/services/agent/AgentComposerService', () => ({ clearAllSessions: jest.fn() }));
jest.mock('@/lib/chat/chatHistory', () => ({
  clearChatHistory: jest.fn(),
  stopChatTurn: jest.fn(),
}));
const mockSecure = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => mockSecure.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void mockSecure.set(key, value),
  deleteItemAsync: async (key: string) => void mockSecure.delete(key),
}));

import { useAuthStore } from '@/store/useAuthStore';
import { useUsageStore } from '@/store/useUsageStore.android';
import { useEndedSession } from '../auth/endedSession';
import { SESSION_CHECK_TIMEOUT_MS, observeEndedSessions } from '../authLifecycle';

const alex = { id: 'alex', email: 'alex@example.com', emailVerified: true, isAnonymous: false };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
  mockSecure.clear();
  mockGetStoredSession.mockResolvedValue(null);
  mockReadSavedSession.mockResolvedValue(null);
  mockCheckSession.mockResolvedValue({ state: 'unknown' });
  useEndedSession.setState({ user: null, sheetPending: false });
  useUsageStore.setState({ sessionRejected: false });
  useAuthStore.setState({ user: null, sessionCookie: null, isGuest: false, isInitialized: false });
});

it('never waits on the server without a stored session', async () => {
  await useAuthStore.getState().initialize();
  expect(mockCheckSession).not.toHaveBeenCalled();
  expect(useAuthStore.getState()).toMatchObject({ user: null, isInitialized: true });
  expect(mockPrepareAccountData).toHaveBeenCalledWith(null);
});

it('opens on the saved session before the server answers, then keeps it when it is valid', async () => {
  mockGetStoredSession.mockResolvedValue('openwhispr.session_token=t');
  mockReadSavedSession.mockResolvedValue({ user: alex, current: true });
  const answer = deferred<{ state: 'valid'; user: typeof alex }>();
  mockCheckSession.mockReturnValue(answer.promise);

  await useAuthStore.getState().initialize();
  expect(useAuthStore.getState()).toMatchObject({ user: alex, isInitialized: true });
  expect(mockCheckSession).toHaveBeenCalledWith(SESSION_CHECK_TIMEOUT_MS);
  expect(SESSION_CHECK_TIMEOUT_MS).toBe(5000);

  answer.resolve({ state: 'valid', user: { ...alex, email: 'new@example.com' } as typeof alex });
  await flush();
  expect(useAuthStore.getState().user?.email).toBe('new@example.com');
  expect(useEndedSession.getState().user).toBeNull();
});

it('keeps the account on screen when no answer comes (offline, timeout)', async () => {
  mockGetStoredSession.mockResolvedValue('openwhispr.session_token=t');
  mockReadSavedSession.mockResolvedValue({ user: alex, current: true });
  await useAuthStore.getState().initialize();
  await flush();
  expect(useAuthStore.getState().user).toEqual(alex);
  expect(useEndedSession.getState().user).toBeNull();
  expect(useUsageStore.getState().sessionRejected).toBe(false);
});

it('keeps the workspace and shows the sheet once when the server ended the session', async () => {
  mockGetStoredSession.mockResolvedValue('openwhispr.session_token=t');
  mockReadSavedSession.mockResolvedValue({ user: alex, current: true });
  mockCheckSession.mockResolvedValue({ state: 'ended' });

  await useAuthStore.getState().initialize();
  await flush();
  expect(useAuthStore.getState().user).toEqual(alex);
  expect(mockPrepareAccountData).toHaveBeenLastCalledWith(alex);
  expect(useEndedSession.getState()).toMatchObject({ user: alex, sheetPending: true });
  expect(useUsageStore.getState().sessionRejected).toBe(true);

  // The next launch finds no session at all (the server's answer cleared it) and still opens on
  // the account, without the sheet once it was shown.
  require('../auth/endedSession').markEndedSheetShown();
  await flush();
  useEndedSession.setState({ user: null, sheetPending: false });
  mockGetStoredSession.mockResolvedValue(null);
  mockReadSavedSession.mockResolvedValue(null);
  mockCheckSession.mockClear();
  await useAuthStore.getState().initialize();
  expect(mockCheckSession).not.toHaveBeenCalled();
  expect(useAuthStore.getState().user).toEqual(alex);
  expect(useEndedSession.getState()).toMatchObject({ user: alex, sheetPending: false });
});

it('asks once about an expired saved session and keeps its account when it ended', async () => {
  mockGetStoredSession.mockResolvedValue('openwhispr.session_token=t');
  mockReadSavedSession.mockResolvedValue({ user: alex, current: false });
  mockCheckSession.mockResolvedValue({ state: 'ended' });
  await useAuthStore.getState().initialize();
  expect(mockCheckSession).toHaveBeenCalledTimes(1);
  expect(useAuthStore.getState().user).toEqual(alex);
  expect(useEndedSession.getState()).toMatchObject({ user: alex, sheetPending: true });
});

it('signs an anonymous session out as before when it ended', async () => {
  const anonymous = {
    id: 'anon',
    email: 'temp@anon.invalid',
    emailVerified: false,
    isAnonymous: true,
  };
  mockGetStoredSession.mockResolvedValue('openwhispr.session_token=t');
  mockReadSavedSession.mockResolvedValue({ user: anonymous, current: true });
  mockCheckSession.mockResolvedValue({ state: 'ended' });
  await useAuthStore.getState().initialize();
  await flush();
  expect(useAuthStore.getState().user).toBeNull();
  expect(useEndedSession.getState().user).toBeNull();
});

it('treats a session refused while the app runs like one found at launch', async () => {
  useAuthStore.setState({ user: alex, sessionCookie: 'c', isGuest: false });
  const stop = observeEndedSessions();
  useUsageStore.setState({ sessionRejected: true });
  expect(useEndedSession.getState()).toMatchObject({ user: alex, sheetPending: true });
  stop();
});

it('forgets the ended session once the account signs in again', async () => {
  useEndedSession.setState({ user: alex, sheetPending: false });
  const { androidAuthLifecycle } = require('../authLifecycle');
  androidAuthLifecycle.prepareLocalData(alex);
  expect(useEndedSession.getState().user).toBeNull();
});
