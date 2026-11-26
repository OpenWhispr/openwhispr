import { Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { NoteShareSheet } from '@/components/notes/NoteShareSheet';
import { NoteShareAccessList } from '@/components/notes/NoteShareAccessList';
import { NoteShareInviteField } from '@/components/notes/NoteShareInviteField';
import { confirmDestructive } from '@/lib/alerts';
import { isCloudBackupEnabled } from '@/lib/cloudBackup';
import { noteShareMenuActions } from '@/components/notes/noteShareMenuActions.android';

let mockCopyCalls = 0;
const mockOwner = {
  type: 'user' as const,
  id: 'owner',
  name: 'Owner',
  email: 'owner@example.invalid',
  image: null,
  member_count: null,
};
const mockAccess = {
  owner: mockOwner,
  grants: [],
  my_permission: 'owner' as const,
  can_manage_access: true,
  can_manage_inherited_access: false,
};
const mockSharing = {
  user: { id: 'owner', email: 'owner@example.invalid' },
  note: { id: 1, isPrivate: 0, remoteId: 'remote-1' },
  state: {
    share: { visibility: 'link', domain_allowlist: [] },
    access: mockAccess,
    invitations: [],
  },
  loading: false,
  busy: false,
  cancellable: false,
  error: null,
  message: null,
  sharingMode: null,
  hasLink: true,
};
jest.mock('react-native', () => {
  const native = jest.requireActual('react-native');
  Object.defineProperty(native.Platform, 'OS', { configurable: true, value: 'ios' });
  return native;
});
jest.mock('@/hooks/useAndroidCopy', () => ({
  useAndroidCopy: () => {
    mockCopyCalls++;
    return { copy: (_key: string, fallback: string) => fallback };
  },
}));
jest.mock('@/lib/cloudBackup', () => ({
  isCloudBackupEnabled: jest.fn((config) => config?.cloudBackupEnabled ?? true),
}));
jest.mock('@/components/notes/noteShareMenuActions.android', () => ({
  noteShareMenuActions: jest.fn((actions) => actions),
}));
jest.mock('@/hooks/useNoteSharing', () => ({
  INVALID_EMAIL_ERROR: 'Enter a valid email address.',
  useNoteSharing: () => mockSharing,
}));
jest.mock('@/android/hooks/useNoteSharing', () => jest.requireMock('@/hooks/useNoteSharing'));
jest.mock('@/data/remote/noteSharingApi', () => ({ searchNoteAccessPrincipals: jest.fn() }));
jest.mock('@/android/shared/data/remote/noteSharingApi', () =>
  jest.requireMock('@/data/remote/noteSharingApi'),
);
jest.mock('@/lib/alerts', () => ({ confirmDestructive: jest.fn() }));
jest.mock('@/android/lib/alerts', () => jest.requireMock('@/lib/alerts'));
jest.mock('@react-native-menu/menu', () => ({
  MenuView: jest.fn(require('@/components/notes/__tests__/menuViewMock').MenuView),
}));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({ GlassIconButton: () => null }));
jest.mock('@/android/shared/components/ui/GlassIconButton', () =>
  jest.requireMock('@/components/ui/GlassIconButton'),
);
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: any) => selector({ config: {} }),
}));
jest.mock('@/android/store/useConfigStore', () => jest.requireMock('@/store/useConfigStore'));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (selector: any) => selector({ setNotePrivacy: jest.fn(), spaces: [] }),
}));
jest.mock('@/android/store/useNotesStore', () => jest.requireMock('@/store/useNotesStore'));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: (selector: any) => selector({ usage: { isSubscribed: true } }),
}));
jest.mock('@/android/store/useUsageStore', () => jest.requireMock('@/store/useUsageStore'));
jest.mock('@/sync/useSyncStore', () => ({
  useSyncStore: (selector: any) => selector({ subscriptionRequired: false }),
}));
jest.mock('@/android/shared/sync/useSyncStore', () => jest.requireMock('@/sync/useSyncStore'));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));
jest.mock('@/android/sync/syncEngine', () => jest.requireMock('@/sync/syncEngine'));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: jest.fn() }),
}));
jest.mock('@/android/shared/hooks/useSuperwallGate', () =>
  jest.requireMock('@/hooks/useSuperwallGate'),
);

beforeEach(() => {
  mockCopyCalls = 0;
  jest.clearAllMocks();
});
function sheet() {
  return render(
    <NoteShareSheet noteId={1} onClose={jest.fn()} onFlushDraft={jest.fn()} onExport={jest.fn()} />,
  );
}
function invite() {
  return render(
    <NoteShareInviteField
      value="friend@example.invalid"
      onChangeText={jest.fn()}
      onInvite={jest.fn()}
      busy={false}
    />,
  );
}
function access() {
  return render(
    <NoteShareAccessList
      access={mockAccess}
      invitations={[
        {
          id: 'i1',
          email: 'friend@example.invalid',
          invited_by_user_id: 'owner',
          permission: 'viewer',
          accepted_at: null,
          revoked_at: null,
          last_emailed_at: null,
          created_at: '',
        },
      ]}
      busy={false}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
}
it.each([
  ['sheet', sheet],
  ['access list', access],
  ['invite field', invite],
] as const)('does not run Android copy hooks from the default %s', (_name, mount) => {
  mount();
  expect(mockCopyCalls).toBe(0);
});
it('preserves the two upstream invite Text children', () => {
  const view = invite();
  const label = view
    .UNSAFE_getAllByType(Text)
    .find(
      (item) =>
        Array.isArray(item.props.children) &&
        item.props.children.join('') === 'Invite friend@example.invalid',
    );
  expect(label?.props.children).toEqual(['Invite ', 'friend@example.invalid']);
});
it('uses the upstream backup selector and direct menu on the default sheet', () => {
  sheet();
  expect(isCloudBackupEnabled).not.toHaveBeenCalled();
  expect(noteShareMenuActions).not.toHaveBeenCalled();
});
it('preserves the default sheet confirmation options', () => {
  const view = sheet();
  fireEvent.press(view.getByTestId('menu-disable-sharing'));
  expect(confirmDestructive).toHaveBeenCalledWith(
    'Disable external sharing?',
    expect.any(String),
    expect.any(Function),
    { destructiveLabel: 'Disable external sharing' },
  );
});
it('preserves the default access confirmation options and direct menu', () => {
  const view = access();
  fireEvent.press(view.getByTestId('menu-invitation:i1:revoke'));
  expect(confirmDestructive).toHaveBeenCalledWith(
    'Revoke invitation?',
    expect.any(String),
    expect.any(Function),
    { destructiveLabel: 'Revoke' },
  );
  expect(noteShareMenuActions).not.toHaveBeenCalled();
});
