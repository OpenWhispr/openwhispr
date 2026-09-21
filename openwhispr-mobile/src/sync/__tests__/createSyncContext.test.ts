jest.mock('@/store/useAuthStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  return {
    useAuthStore: create(() => ({
      user: { id: 'account-a' },
      sessionCookie: 'session-a',
      isGuest: false,
      isLoading: false,
    })),
  };
});
jest.mock('@/store/useConfigStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  return {
    useConfigStore: create(() => ({
      config: { cloudBackupEnabled: true },
      isLoading: false,
      error: null,
    })),
  };
});
import { useAuthStore } from '@/store/useAuthStore';
import { useConfigStore } from '@/store/useConfigStore';
import { createSyncContext } from '../createSyncContext';
import { SyncCancelledError } from '../syncContext';

beforeEach(() => {
  useAuthStore.setState({
    user: { id: 'account-a' } as NonNullable<ReturnType<typeof useAuthStore.getState>['user']>,
    sessionCookie: 'session-a',
    isGuest: false,
    isLoading: false,
  });
  useConfigStore.setState({
    config: { defaultMode: 'cloud', cloudBackupEnabled: true },
    isLoading: false,
    error: null,
  });
});

it('permanently invalidates a run after switching away and back to the same account', () => {
  const context = createSyncContext();
  const before = useAuthStore.getState();
  useAuthStore.setState({ user: { ...before.user!, id: 'account-b' } });
  useAuthStore.setState(before);
  expect(() => context.checkpoint()).toThrow(SyncCancelledError);
  context.dispose();
});

it('invalidates the run if the session cookie changes without a user-id change', () => {
  const context = createSyncContext();
  useAuthStore.setState({ sessionCookie: 'new-session' });
  expect(() => context.checkpoint()).toThrow(SyncCancelledError);
  context.dispose();
});

it('keeps upload cancelled after backup is disabled and immediately re-enabled', () => {
  const context = createSyncContext();
  useConfigStore.setState({ config: { defaultMode: 'cloud', cloudBackupEnabled: false } });
  useConfigStore.setState({ config: { defaultMode: 'cloud', cloudBackupEnabled: true } });
  expect(() => context.checkpoint(true)).toThrow(SyncCancelledError);
  expect(() => context.checkpoint()).not.toThrow();
  context.dispose();
});

it('keeps uploading while an unrelated preference save is in flight', () => {
  const context = createSyncContext();
  useConfigStore.setState({ isLoading: true });
  expect(() => context.checkpoint(true)).not.toThrow();
  useConfigStore.setState({ isLoading: false });
  expect(() => context.checkpoint(true)).not.toThrow();
  context.dispose();
});

it('keeps uploading after a preference storage error', () => {
  const context = createSyncContext();
  useConfigStore.setState({ error: 'storage unavailable' });
  expect(() => context.checkpoint(true)).not.toThrow();
  context.dispose();
});

it('stops permanently when an auth transition starts, even if it returns to the same session', () => {
  const context = createSyncContext();
  useAuthStore.setState({ isLoading: true });
  useAuthStore.setState({ isLoading: false });
  expect(() => context.checkpoint()).toThrow(SyncCancelledError);
  context.dispose();
});

it('allows team uploads and private-copy deletion when personal backup was already off', () => {
  useConfigStore.setState({ config: { defaultMode: 'cloud', cloudBackupEnabled: false } });
  const context = createSyncContext();
  expect(() => context.checkpoint(true)).not.toThrow();
  expect(() => context.checkpoint()).not.toThrow();
  context.dispose();
});
