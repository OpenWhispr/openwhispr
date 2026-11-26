import { cleanupAsync, render } from '@testing-library/react-native';

const mockImports: string[] = [];
const mockLoad = jest.fn(() => Promise.resolve());

jest.mock('@/hooks/useAndroidCopy', () => {
  mockImports.push('Android copy');
  return {
    useAndroidCopy: () => ({ copy: (_key: string, fallback: string) => fallback, language: 'en' }),
  };
});
jest.mock('@/android/libraryTime', () => {
  mockImports.push('Android time');
  return { formatLibraryTime: jest.fn() };
});
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: (select: (state: unknown) => unknown) =>
    select({ user: { id: 'fixture' }, isGuest: false }),
}));
jest.mock('@/android/store/useAuthStore', () => jest.requireMock('@/store/useAuthStore'));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (select: (state: unknown) => unknown) =>
    select({ config: { cloudBackupEnabled: true } }),
}));
jest.mock('@/android/store/useConfigStore', () => jest.requireMock('@/store/useConfigStore'));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: (select: (state: unknown) => unknown) =>
    select({ usage: { isSubscribed: true }, load: mockLoad }),
}));
jest.mock('@/android/store/useUsageStore', () => jest.requireMock('@/store/useUsageStore'));
jest.mock('@/sync/useSyncStore', () => ({
  useSyncStore: () => ({
    status: 'idle',
    lastSyncAt: null,
    lastError: null,
    subscriptionRequired: false,
    policyBlocked: false,
  }),
}));
jest.mock('@/android/shared/sync/useSyncStore', () => jest.requireMock('@/sync/useSyncStore'));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));
jest.mock('@/android/sync/syncEngine', () => jest.requireMock('@/sync/syncEngine'));
jest.mock('@/data', () => ({ notesRepository: { listConflictedNotes: () => [{ id: 1 }] } }));
jest.mock('@/android/shared/data', () => jest.requireMock('@/data'));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: jest.fn() }),
}));
jest.mock('@/android/shared/hooks/useSuperwallGate', () =>
  jest.requireMock('@/hooks/useSuperwallGate'),
);
jest.mock('@/lib/superwall', () => ({
  SUPERWALL_PLACEMENTS: { cloudSyncRequired: 'cloud_sync_required' },
}));
jest.mock('@/android/shared/lib/superwall', () => jest.requireMock('@/lib/superwall'));
jest.mock('@/lib/utils', () => ({ formatRelativeTime: jest.fn(), safeHaptics: jest.fn() }));
jest.mock('@/android/shared/lib/utils', () => jest.requireMock('@/lib/utils'));

afterEach(async () => {
  await cleanupAsync();
});

it('renders default sync status without importing Android presentation', () => {
  const { SyncStatusLabel } = jest.requireActual('@/components/notes/SyncStatusLabel');
  const screen = render(<SyncStatusLabel />);
  expect(screen.getByText('Not synced yet')).toBeTruthy();
  expect(mockImports).toEqual([]);
});

it('keeps the default conflict badge class unchanged', () => {
  const { SyncStatusLabel } = jest.requireActual('@/components/notes/SyncStatusLabel');
  const screen = render(<SyncStatusLabel />);
  expect(screen.getByText('1 note needs review').props.className).toBe(
    'text-[13px] font-medium text-systemOrange',
  );
});
