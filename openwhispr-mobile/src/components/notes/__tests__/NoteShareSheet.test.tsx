import { AccessibilityInfo, Alert } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { INVALID_EMAIL_ERROR, type NoteSharingController } from '@/hooks/useNoteSharing';
import { searchNoteAccessPrincipals } from '@/data/remote/noteSharingApi';
import { NoteShareSheet } from '../NoteShareSheet';

const mockController = {
  state: null,
  loading: false,
  busy: false,
  cancellable: false,
  error: null,
  message: null,
  hasLink: false,
  sharingMode: null,
  note: { id: 1, isPrivate: 0, remoteId: 'remote-1' },
  user: { id: 'user-1', email: 'owner@example.com' },
  refresh: jest.fn(),
  dismissError: jest.fn(),
  setVisibility: jest.fn(),
  replaceLink: jest.fn(),
  copyLink: jest.fn(),
  shareLink: jest.fn(),
  openLink: jest.fn(),
  inviteEmail: jest.fn(),
  addPrincipal: jest.fn(),
  updateGrant: jest.fn(),
  removeGrant: jest.fn(),
  revokeInvitation: jest.fn(),
  resendInvitation: jest.fn(),
} as unknown as NoteSharingController;
const mockSetNotePrivacy = jest.fn();
const mockRegisterGate = jest.fn(() => Promise.resolve(true));
const mockSpaces: { id: number; kind: string }[] = [];
let mockUsage: { isSubscribed: boolean } | null = null;

jest.mock('@/hooks/useNoteSharing', () => ({
  INVALID_EMAIL_ERROR: 'Enter a valid email address.',
  useNoteSharing: () => mockController,
}));
jest.mock('@/data/remote/noteSharingApi', () => ({ searchNoteAccessPrincipals: jest.fn() }));
jest.mock('@react-native-menu/menu', () => require('./menuViewMock'));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));
jest.mock('@/components/ui/GlassIconButton', () => ({
  GlassIconButton: ({
    onPress,
    accessibilityLabel,
  }: {
    onPress: () => void;
    accessibilityLabel: string;
  }) => {
    const { Pressable } = require('react-native');
    return <Pressable onPress={onPress} accessibilityLabel={accessibilityLabel} />;
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
let mockCloudBackupEnabled = true;
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: { config: { cloudBackupEnabled: boolean } }) => unknown) =>
    selector({ config: { cloudBackupEnabled: mockCloudBackupEnabled } }),
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (
    selector: (state: {
      setNotePrivacy: () => Promise<void>;
      spaces: { id: number; kind: string }[];
    }) => unknown,
  ) => selector({ setNotePrivacy: mockSetNotePrivacy, spaces: mockSpaces }),
}));
jest.mock('@/store/useUsageStore', () => ({
  useUsageStore: Object.assign(
    (selector: (state: { usage: typeof mockUsage }) => unknown) => selector({ usage: mockUsage }),
    { getState: () => ({ load: () => Promise.resolve() }) },
  ),
}));
let mockSubscriptionRequired = false;
jest.mock('@/sync/useSyncStore', () => ({
  useSyncStore: (selector: (state: { subscriptionRequired: boolean }) => unknown) =>
    selector({ subscriptionRequired: mockSubscriptionRequired }),
}));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));
jest.mock('@/hooks/useSuperwallGate', () => ({
  useSuperwallGate: () => ({ register: mockRegisterGate }),
}));

const share = {
  visibility: 'private' as const,
  token_prefix: null,
  domain_allowlist: [],
  updated_at: null,
  updated_by_user_id: null,
};
const access = {
  owner: {
    type: 'user' as const,
    id: 'owner',
    name: 'Owner',
    email: 'owner@example.com',
    image: null,
    member_count: null,
  },
  grants: [],
  my_permission: 'owner' as const,
  can_manage_access: true,
  can_manage_inherited_access: false,
};
const pendingInvitation = {
  id: 'inv-1',
  email: 'pending@example.com',
  invited_by_user_id: 'owner',
  permission: 'viewer' as const,
  accepted_at: null,
  revoked_at: null,
  last_emailed_at: null,
  created_at: '',
};
const props = {
  noteId: 1,
  onClose: jest.fn(),
  onFlushDraft: jest.fn(),
  onExport: jest.fn(),
};

beforeEach(() => {
  Object.assign(mockController, {
    state: null,
    loading: false,
    busy: false,
    cancellable: false,
    error: null,
    message: null,
    hasLink: false,
    sharingMode: null,
    note: { id: 1, isPrivate: 0, remoteId: 'remote-1' },
    user: { id: 'user-1', email: 'owner@example.com' },
  });
  mockSpaces.length = 0;
  mockUsage = null;
  mockCloudBackupEnabled = true;
  mockSubscriptionRequired = false;
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
});

it('offers invited sharing and email invitation before a new note has a remote ID', () => {
  mockController.note = { ...mockController.note!, remoteId: null };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByTestId('menu-visibility:invited'));
  expect(mockController.setVisibility).toHaveBeenCalledWith('invited');
  fireEvent.changeText(screen.getByLabelText('Invite by email'), 'friend@example.com');
  fireEvent.press(screen.getByLabelText('Invite friend@example.com'));
  expect(mockController.inviteEmail).toHaveBeenCalledWith('friend@example.com');
});

it('offers the owner business domain without making a new note public', () => {
  mockController.note = { ...mockController.note!, remoteId: null };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByTestId('menu-visibility:domain'));
  expect(mockController.setVisibility).toHaveBeenCalledWith('domain', ['example.com']);
  expect(mockController.setVisibility).not.toHaveBeenCalledWith('link');
});

it('asks for cloud sync consent before changing a private note', () => {
  mockController.note = { ...mockController.note!, isPrivate: 1 };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.queryByText('Create link')).toBeNull();
  fireEvent.press(screen.getByText('Enable cloud sync'));
  expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Enable cloud sync?');
});

it('lets a private note revoke its retained cloud link without enabling sync', () => {
  mockController.note = { ...mockController.note!, isPrivate: 1 };
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'abc' },
    invitations: [],
    access: {
      owner: {
        type: 'user',
        id: 'owner',
        name: 'Owner',
        email: 'owner@example.com',
        image: null,
        member_count: null,
      },
      grants: [],
      my_permission: 'owner',
      can_manage_access: true,
      can_manage_inherited_access: false,
    },
  };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByText('Disable previous link'));
  const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
  expect((Alert.alert as jest.Mock).mock.calls[0][1]).toMatch(/links stop working/i);
  expect((Alert.alert as jest.Mock).mock.calls[0][1]).toMatch(/new link/i);
  expect((Alert.alert as jest.Mock).mock.calls[0][1]).not.toMatch(/links.*until you share/i);
  expect((Alert.alert as jest.Mock).mock.calls[0][1]).not.toMatch(/team and space access remains/i);
  buttons[1].onPress();
  expect(mockController.setVisibility).toHaveBeenCalledWith('private');
  expect(mockSetNotePrivacy).not.toHaveBeenCalled();
  expect(props.onFlushDraft).not.toHaveBeenCalled();
});

it('does not offer private-link revocation without confirmed management permission', () => {
  mockController.note = { ...mockController.note!, isPrivate: 1 };
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'abc' },
    invitations: [],
    access: {
      owner: {
        type: 'user',
        id: 'owner',
        name: 'Owner',
        email: 'owner@example.com',
        image: null,
        member_count: null,
      },
      grants: [],
      my_permission: 'viewer',
      can_manage_access: false,
      can_manage_inherited_access: false,
    },
  };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.queryByText('Disable previous link')).toBeNull();
});

it('shows a failed cloud sync opt-in', async () => {
  mockController.note = { ...mockController.note!, isPrivate: 1 };
  mockSetNotePrivacy.mockRejectedValueOnce(new Error('Sync unavailable'));
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByText('Enable cloud sync'));
  const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
  await act(async () => {
    await buttons[1].onPress();
  });
  expect(screen.getByText('Unable to enable cloud sync. Try again.')).toBeTruthy();
  expect(screen.queryByText('Sync unavailable')).toBeNull();
});

it('keeps both exports available when sharing settings cannot load', () => {
  mockController.error = 'Network unavailable';
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Network unavailable')).toBeTruthy();
  expect(screen.queryByText('Create link')).toBeNull();
  fireEvent.press(screen.getByText('Retry'));
  expect(mockController.refresh).toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Export Markdown'));
  expect(props.onExport).toHaveBeenCalledWith('md');
});

it('creates public links only after an explicit tap', () => {
  mockController.state = { share, invitations: [], access };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Not shared with anyone')).toBeTruthy();
  expect(mockController.setVisibility).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Create link'));
  expect(mockController.setVisibility).toHaveBeenCalledWith('link');
});

it('shows the actual invited setting and confirms replacement of an unavailable token', () => {
  mockController.state = {
    share: { ...share, visibility: 'invited', token_prefix: 'abc' },
    invitations: [],
    access,
  };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Invited people')).toBeTruthy();
  expect(screen.queryByText('Create link')).toBeNull();
  fireEvent.press(screen.getByTestId('menu-replace-link'));
  const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
  expect((Alert.alert as jest.Mock).mock.calls[0][1]).toContain('previous link will stop working');
  buttons[1].onPress();
  expect(mockController.replaceLink).toHaveBeenCalled();
});

it('lets a manager replace a known link and shows a busy status', () => {
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'abc' },
    invitations: [],
    access,
  };
  mockController.hasLink = true;
  mockController.busy = true;
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Updating sharing…')).toBeTruthy();
  expect(screen.getByTestId('menu-replace-link')).toBeTruthy();
  expect(screen.queryByLabelText('Close share sheet')).toBeNull();
});

it('hides link management actions when access cannot be managed', () => {
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'abc' },
    invitations: [],
    access: {
      owner: {
        type: 'user',
        id: 'owner',
        name: 'Owner',
        email: 'owner@example.com',
        image: null,
        member_count: null,
      },
      grants: [],
      my_permission: 'viewer',
      can_manage_access: false,
      can_manage_inherited_access: false,
    },
  };
  mockController.hasLink = true;
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.queryByLabelText('Share link')).toBeNull();
  expect(screen.queryByTestId('menu-replace-link')).toBeNull();
  expect(screen.getByLabelText('Export Markdown')).toBeTruthy();
});

it('allows legacy sharing revocation when the share endpoint authorizes access', () => {
  mockController.note = { ...mockController.note!, isPrivate: 1 };
  mockController.state = { share: { ...share, visibility: 'link' }, invitations: [], access };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Disable previous link')).toBeTruthy();
});

it('confirms before widening a restricted share to anyone with the link', () => {
  mockController.state = {
    share: { ...share, visibility: 'invited', token_prefix: 'abc' },
    invitations: [],
    access,
  };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByTestId('menu-visibility:link'));
  expect(mockController.setVisibility).not.toHaveBeenCalled();
  const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
  expect(title).toBe('Make this note public?');
  buttons[1].onPress();
  expect(mockController.setVisibility).toHaveBeenCalledWith('link');
});

it('marks the current access mode as selected for assistive technology', () => {
  mockController.state = {
    share: { ...share, visibility: 'invited', token_prefix: 'abc' },
    invitations: [],
    access,
  };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByTestId('menu-visibility:invited').props.accessibilityState).toMatchObject({
    selected: true,
  });
  expect(screen.getByTestId('menu-visibility:link').props.accessibilityState).toMatchObject({
    selected: false,
  });
});

it('shows paused direct access after external sharing is disabled', () => {
  mockController.state = { share, invitations: [pendingInvitation], access };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText(/Pending invitation · Paused/)).toBeTruthy();
});

it('confirms before widening invited-only sharing to the organization', () => {
  mockController.state = {
    share: { ...share, visibility: 'invited', token_prefix: 'abc' },
    invitations: [],
    access,
  };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByTestId('menu-visibility:domain'));
  expect(mockController.setVisibility).not.toHaveBeenCalled();
  const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
  expect(title).toBe('Share with example.com?');
  buttons[1].onPress();
  expect(mockController.setVisibility).toHaveBeenCalledWith('domain', ['example.com']);
});

it('narrows sharing without asking', () => {
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'abc' },
    invitations: [],
    access,
  };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByTestId('menu-visibility:invited'));
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(mockController.setVisibility).toHaveBeenCalledWith('invited');
});

it('describes a private team-space note as shared with the space', () => {
  mockSpaces.push({ id: 7, kind: 'team' });
  mockController.note = {
    ...mockController.note!,
    spaceId: 7,
  } as typeof mockController.note;
  mockController.state = { share, invitations: [], access };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Everyone in this team space')).toBeTruthy();
  expect(screen.queryByText('Only you')).toBeNull();
});

it('warns that replacing a link breaks links in invitation emails', () => {
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'ow_share_abcdefg' },
    invitations: [pendingInvitation],
    access,
  };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByTestId('menu-replace-link'));
  expect((Alert.alert as jest.Mock).mock.calls[0][1]).toMatch(/invitation emails/i);
});

it('clears the email field only after a confirmed invitation', async () => {
  jest.mocked(mockController.inviteEmail).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  mockController.state = { share, invitations: [], access };
  const screen = render(<NoteShareSheet {...props} />);
  const input = screen.getByLabelText('Add people or emails');
  fireEvent.changeText(input, 'friend@example.com');
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Invite friend@example.com'));
  });
  expect(screen.getByLabelText('Add people or emails').props.value).toBe('friend@example.com');
  await act(async () => {
    fireEvent.press(screen.getByLabelText('Invite friend@example.com'));
  });
  expect(screen.getByLabelText('Add people or emails').props.value).toBe('');
});

it('can be closed while the note is still uploading, but not while sharing is saved', () => {
  mockController.busy = true;
  mockController.cancellable = true;
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByLabelText('Close share sheet'));
  expect(props.onClose).toHaveBeenCalled();
  mockController.cancellable = false;
  screen.rerender(<NoteShareSheet {...props} />);
  expect(screen.queryByLabelText('Close share sheet')).toBeNull();
});

it('does not flash the pending-removal note while checking a private note', () => {
  mockController.note = { ...mockController.note!, isPrivate: 1 };
  mockController.loading = true;
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Checking previous sharing…')).toBeTruthy();
  expect(screen.queryByText(/Removal of a previous cloud copy/)).toBeNull();
});

it('offers only domain sharing under a domain-only organization policy', () => {
  mockController.user = { id: 'user-1', email: 'owner@company.com' } as typeof mockController.user;
  mockController.sharingMode = 'domain_only';
  mockController.state = { share, invitations: [], access };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText(/only allows sharing within your company/i)).toBeTruthy();
  expect(screen.queryByText('Create link')).toBeNull();
  expect(screen.queryByTestId('menu-visibility:invited')).toBeNull();
  expect(screen.queryByLabelText('Add people or emails')).toBeNull();
  fireEvent.press(screen.getByTestId('menu-visibility:domain'));
  expect(mockController.setVisibility).toHaveBeenCalledWith('domain', ['company.com']);
});

it('keeps only disabling when the organization does not allow external sharing', () => {
  mockController.sharingMode = 'disabled';
  mockController.hasLink = true;
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'ow_share_abcdefg' },
    invitations: [],
    access,
  };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText(/does not allow sharing notes outside/i)).toBeTruthy();
  expect(screen.queryByTestId('menu-visibility:invited')).toBeNull();
  expect(screen.queryByText('Copy link')).toBeNull();
  expect(screen.queryByTestId('menu-replace-link')).toBeNull();
  expect(screen.getByTestId('menu-disable-sharing')).toBeTruthy();
});

it('offers an upgrade before uploading a personal note without a subscription', () => {
  mockUsage = { isSubscribed: false };
  mockController.note = { ...mockController.note!, remoteId: null };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.queryByText('Create link')).toBeNull();
  fireEvent.press(screen.getByText('Upgrade to Pro'));
  expect(mockRegisterGate).toHaveBeenCalledWith(
    expect.objectContaining({ placement: 'cloud_sync_required' }),
  );
});

it('greys out link actions while an operation runs', () => {
  mockController.busy = true;
  mockController.hasLink = true;
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'ow_share_abcdefg' },
    invitations: [],
    access,
  };
  const screen = render(<NoteShareSheet {...props} />);
  for (const label of ['Share link', 'Copy link', 'Open in browser']) {
    expect(screen.getByLabelText(label).props.accessibilityState).toMatchObject({ disabled: true });
  }
  expect(screen.getByTestId('menu-replace-link').props.accessibilityState).toMatchObject({
    disabled: true,
  });
});

it('keeps the sheet open while a previous link is being disabled', () => {
  mockCloudBackupEnabled = false;
  mockController.busy = true;
  mockController.note = { ...mockController.note!, isPrivate: 1 };
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'ow_share_abcdefg' },
    invitations: [],
    access,
  };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByLabelText('Open privacy settings').props.accessibilityState).toMatchObject({
    disabled: true,
  });
});

it('keeps existing sharing manageable but blocks uploads while cloud backup is off', () => {
  mockCloudBackupEnabled = false;
  mockController.hasLink = true;
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'ow_share_abcdefg' },
    invitations: [pendingInvitation],
    access,
  };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText(/Cloud backup is off\. Turn it on in Privacy & Data/)).toBeTruthy();
  expect(screen.getByText('Open privacy settings')).toBeTruthy();
  expect(screen.getByText('pending@example.com')).toBeTruthy();
  expect(screen.getByTestId('menu-invitation:inv-1:revoke')).toBeTruthy();
  expect(screen.getByText('Copy link')).toBeTruthy();
  expect(screen.queryByLabelText('Invite by email')).toBeNull();
  expect(screen.queryByTestId('menu-replace-link')).toBeNull();
  expect(screen.queryByTestId('menu-visibility:invited')).toBeNull();
  expect(screen.queryByLabelText('Add people or emails')).toBeNull();
  fireEvent.press(screen.getByTestId('menu-disable-sharing'));
  const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
  buttons[1].onPress();
  expect(mockController.setVisibility).toHaveBeenCalledWith('private');
});

it('points a never-uploaded personal note at privacy settings while cloud backup is off', () => {
  mockCloudBackupEnabled = false;
  mockController.note = { ...mockController.note!, remoteId: null };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText(/Cloud backup is off/)).toBeTruthy();
  expect(screen.getByText('Open privacy settings')).toBeTruthy();
  expect(screen.queryByText('Create link')).toBeNull();
  expect(screen.queryByLabelText('Invite by email')).toBeNull();
});

it('marks the sheet title as a heading', () => {
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByRole('header', { name: 'Share note' })).toBeTruthy();
});

it('offers Pro when new edits to a synced note cannot sync without it', () => {
  mockSubscriptionRequired = true;
  mockController.state = { share, invitations: [], access };
  mockController.error = 'An active subscription is required to sync this note.';
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByText('Upgrade to Pro'));
  expect(mockRegisterGate).toHaveBeenCalled();
});

it('shows errors beside the controls with a way to refresh', () => {
  mockController.state = { share, invitations: [], access };
  mockController.error = 'Sharing settings changed. Refresh and try again.';
  const spy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const screen = render(<NoteShareSheet {...props} />);
  expect(spy).toHaveBeenCalledWith('Sharing settings changed. Refresh and try again.');
  expect(screen.queryByText('Upgrade to Pro')).toBeNull();
  fireEvent.press(screen.getByLabelText('Refresh sharing settings'));
  expect(mockController.refresh).toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText('Add people or emails'), 'friend@');
  expect(mockController.dismissError).not.toHaveBeenCalled();
});

it('clears an invalid email error once the address is edited', () => {
  mockController.state = { share, invitations: [], access };
  mockController.error = INVALID_EMAIL_ERROR;
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.changeText(screen.getByLabelText('Add people or emails'), 'friend@example.com');
  expect(mockController.dismissError).toHaveBeenCalled();
});

it('does not offer Pro to a subscriber whose sync check failed', () => {
  mockUsage = { isSubscribed: true };
  mockSubscriptionRequired = true;
  mockController.state = { share, invitations: [], access };
  mockController.error = 'Can’t reach OpenWhispr. Check your connection and try again.';
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.queryByText('Upgrade to Pro')).toBeNull();
});

const pausedGrant = {
  id: 'grant-1',
  principal: { ...access.owner, id: 'user-2', name: 'Jamie', email: 'jamie@example.com' },
  permission: 'viewer' as const,
  source: 'direct' as const,
  inherited: false,
  pending: false,
  created_at: '',
  updated_at: '',
};
it('keeps the controls while an operation loads settings after the first upload', () => {
  Object.assign(mockController, { busy: true, state: null });
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.queryByText('Sharing settings are unavailable.')).toBeNull();
  expect(screen.queryByText('Retry')).toBeNull();
  expect(screen.getByLabelText('Invite by email')).toBeTruthy();
});
it('asks before an invitation turns paused sharing back on', () => {
  mockController.state = { share, invitations: [], access: { ...access, grants: [pausedGrant] } };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.changeText(screen.getByLabelText('Add people or emails'), 'friend@example.com');
  fireEvent.press(screen.getByLabelText('Invite friend@example.com'));
  expect(mockController.inviteEmail).not.toHaveBeenCalled();
  const [title, message, buttons] = (Alert.alert as jest.Mock).mock.calls[0];
  expect(title).toBe('Turn sharing back on?');
  expect(message).toMatch(/get their access back/i);
  buttons[1].onPress();
  expect(mockController.inviteEmail).toHaveBeenCalledWith('friend@example.com');
});
it('reports an invalid address on a paused share without asking first', () => {
  mockController.state = { share, invitations: [], access: { ...access, grants: [pausedGrant] } };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.changeText(screen.getByLabelText('Add people or emails'), 'not-an-email');
  fireEvent(screen.getByLabelText('Add people or emails'), 'submitEditing');
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(mockController.inviteEmail).toHaveBeenCalledWith('not-an-email');
});
it('invites without asking when no access is paused', () => {
  const inherited = { ...pausedGrant, id: 'scope:space-1', inherited: true };
  mockController.state = { share, invitations: [], access: { ...access, grants: [inherited] } };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.changeText(screen.getByLabelText('Add people or emails'), 'friend@example.com');
  fireEvent.press(screen.getByLabelText('Invite friend@example.com'));
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(mockController.inviteEmail).toHaveBeenCalledWith('friend@example.com');
});
it('asks before adding someone turns paused sharing back on', async () => {
  jest.mocked(searchNoteAccessPrincipals).mockResolvedValue({
    suggestions: [
      {
        type: 'user',
        id: 'user-3',
        name: 'Riley',
        email: 'riley@example.com',
        image: null,
        member_count: null,
        existing_grant_id: null,
      },
    ],
  });
  mockController.state = { share, invitations: [], access: { ...access, grants: [pausedGrant] } };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.changeText(screen.getByLabelText('Add people or emails'), 'ril');
  await waitFor(() => expect(screen.getByText('Riley')).toBeTruthy());
  fireEvent.press(screen.getByText('Riley'));
  expect(mockController.addPrincipal).not.toHaveBeenCalled();
  expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('Turn sharing back on?');
  (Alert.alert as jest.Mock).mock.calls[0][2][1].onPress();
  expect(mockController.addPrincipal).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'user-3' }),
  );
});
