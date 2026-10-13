const mockStored = new Map<string, string>();

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
jest.mock('@/lib/sentry', () => ({
  Sentry: { captureMessage: jest.fn(), captureException: jest.fn() },
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: { getState: () => ({ reset: jest.fn(), load: jest.fn() }) },
}));
jest.mock('@/services/agent/AgentComposerService', () => ({ clearAllSessions: jest.fn() }));
jest.mock('@/services/providers/ProviderCredentials', () => ({
  clearProviderCredentials: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 3,
  getItemAsync: jest.fn(async (key: string) => mockStored.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStored.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStored.delete(key);
  }),
}));

import * as SecureStore from 'expo-secure-store';
import { useAuthStore } from '@/store/useAuthStore';
import { deleteAccount, getSession, signInWithEmail, signUpWithEmail } from '@/lib/authClient';
import { readNoteShareToken, saveNoteShareToken } from '@/lib/notes/noteShareTokens';
import type { AuthUser } from '@/lib/authClient';

const token = `ow_share_${'A'.repeat(32)}`;
const accountA: AuthUser = {
  id: 'account-a',
  email: 'a@example.com',
  emailVerified: true,
  isAnonymous: false,
};
const accountB: AuthUser = { ...accountA, id: 'account-b', email: 'b@example.com' };
const anonymousUser: AuthUser = {
  id: 'anon-user',
  email: 'temp-1@anon.openwhispr.invalid',
  emailVerified: false,
  isAnonymous: true,
};

async function signInAs(user: AuthUser): Promise<void> {
  jest
    .mocked(signInWithEmail)
    .mockResolvedValueOnce({ user, sessionCookie: `session=${user.id}`, error: null });
  await useAuthStore.getState().signIn(user.email, 'password');
}

async function shareAs(user: AuthUser): Promise<void> {
  await signInAs(user);
  await saveNoteShareToken(user.id, 'note', token);
}

beforeEach(() => {
  mockStored.clear();
  jest.clearAllMocks();
  useAuthStore.setState({
    user: null,
    sessionCookie: null,
    isGuest: false,
    isInitialized: true,
    isLoading: false,
    error: null,
  });
});

it('keeps stored links when the same account signs back in', async (): Promise<void> => {
  await shareAs(accountA);
  await useAuthStore.getState().signOut();
  await signInAs(accountA);
  expect(await readNoteShareToken(accountA.id, 'note')).toBe(token);
});

it('clears the previous account links when a different account signs in', async (): Promise<void> => {
  await shareAs(accountA);
  await useAuthStore.getState().signOut();
  expect(await readNoteShareToken(accountA.id, 'note')).toBe(token);
  await signInAs(accountB);
  expect(await readNoteShareToken(accountA.id, 'note')).toBeNull();
  expect(useAuthStore.getState().user?.id).toBe(accountB.id);
});

it('keeps links through guest mode, then clears them for the next account', async (): Promise<void> => {
  await shareAs(accountA);
  await useAuthStore.getState().signOut();
  await useAuthStore.getState().continueAsGuest();
  expect(await readNoteShareToken(accountA.id, 'note')).toBe(token);
  await signInAs(accountB);
  expect(await readNoteShareToken(accountA.id, 'note')).toBeNull();
});

it('clears the previous account links when an anonymous session signs up as another account', async (): Promise<void> => {
  await shareAs(accountA);
  await useAuthStore.getState().signOut();
  useAuthStore.setState({ user: anonymousUser, sessionCookie: 'session=anon' });
  jest
    .mocked(signUpWithEmail)
    .mockResolvedValueOnce({ user: accountB, sessionCookie: 'session=b', error: null });
  await useAuthStore.getState().signUp(accountB.email, 'password');
  expect(await readNoteShareToken(accountA.id, 'note')).toBeNull();
});

it('clears the previous account links when a different session is restored at launch', async (): Promise<void> => {
  await shareAs(accountA);
  jest.mocked(getSession).mockResolvedValueOnce(accountB);
  await useAuthStore.getState().initialize();
  expect(await readNoteShareToken(accountA.id, 'note')).toBeNull();
});

it('keeps stored links when an anonymous session is restored at launch', async (): Promise<void> => {
  await shareAs(accountA);
  await useAuthStore.getState().signOut();
  jest.mocked(getSession).mockResolvedValueOnce(anonymousUser);
  await useAuthStore.getState().initialize();
  expect(await readNoteShareToken(accountA.id, 'note')).toBe(token);
});

it('clears stored links after the account is deleted', async (): Promise<void> => {
  await shareAs(accountA);
  await useAuthStore.getState().deleteAccount();
  expect(await readNoteShareToken(accountA.id, 'note')).toBeNull();
  expect(mockStored.size).toBe(0);
});

it('keeps stored links when account deletion fails', async (): Promise<void> => {
  await shareAs(accountA);
  jest.mocked(deleteAccount).mockRejectedValueOnce(new Error('Network request failed'));
  await expect(useAuthStore.getState().deleteAccount()).rejects.toThrow(/network/i);
  expect(await readNoteShareToken(accountA.id, 'note')).toBe(token);
  expect(useAuthStore.getState().user?.id).toBe(accountA.id);
});

it('completes a deletion whose link cleanup failed and retries it at the next sign-in', async (): Promise<void> => {
  await shareAs(accountA);
  jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keychain locked'));
  await useAuthStore.getState().deleteAccount();
  expect(useAuthStore.getState()).toMatchObject({ user: null, isLoading: false, error: null });
  expect(await readNoteShareToken(accountA.id, 'note')).toBe(token);
  await signInAs(accountB);
  expect(await readNoteShareToken(accountA.id, 'note')).toBeNull();
});
