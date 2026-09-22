import { Alert } from 'react-native';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { NoteSharingController } from '@/hooks/useNoteSharing';
import { NoteShareSheet } from '../NoteShareSheet';

const mockController = {
  state: null,
  loading: false,
  busy: false,
  error: null,
  message: null,
  hasToken: false,
  note: { id: 1, isPrivate: 0, remoteId: 'remote-1' },
  user: { id: 'user-1', email: 'owner@example.com' },
  refresh: jest.fn(),
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

jest.mock('@/hooks/useNoteSharing', () => ({ useNoteSharing: () => mockController }));
jest.mock('@/data/remote/noteSharingApi', () => ({ searchNoteAccessPrincipals: jest.fn() }));
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
jest.mock('@/store/useConfigStore', () => ({
  useConfigStore: (selector: (state: { config: { cloudBackupEnabled: boolean } }) => unknown) =>
    selector({ config: { cloudBackupEnabled: true } }),
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: (
    selector: (state: { setNotePrivacy: () => Promise<void>; spaces: [] }) => unknown,
  ) => selector({ setNotePrivacy: mockSetNotePrivacy, spaces: [] }),
}));

const share = {
  visibility: 'private' as const,
  token_prefix: null,
  domain_allowlist: [],
  updated_at: null,
  updated_by_user_id: null,
};
const props = {
  noteId: 1,
  visible: true,
  onClose: jest.fn(),
  onFlushDraft: jest.fn(),
  onExport: jest.fn(),
};

beforeEach(() => {
  Object.assign(mockController, {
    state: null,
    loading: false,
    busy: false,
    error: null,
    message: null,
    hasToken: false,
    note: { id: 1, isPrivate: 0, remoteId: 'remote-1' },
    user: { id: 'user-1', email: 'owner@example.com' },
  });
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
});

it('offers invited sharing and email invitation before a new note has a remote ID', () => {
  mockController.note = { ...mockController.note!, remoteId: null };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByText('Invite only'));
  expect(mockController.setVisibility).toHaveBeenCalledWith('invited');
  fireEvent.changeText(screen.getByLabelText('Email address'), 'friend@example.com');
  fireEvent.press(screen.getByLabelText('Invite email'));
  expect(mockController.inviteEmail).toHaveBeenCalledWith('friend@example.com');
});

it('offers the owner business domain without making a new note public', () => {
  mockController.note = { ...mockController.note!, remoteId: null };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByText('Organization (example.com)'));
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
  expect(screen.getByText('Sync unavailable')).toBeTruthy();
});

it('keeps both exports available when sharing settings cannot load', () => {
  mockController.error = 'Network unavailable';
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Network unavailable')).toBeTruthy();
  expect(screen.queryByText('Create link')).toBeNull();
  fireEvent.press(screen.getByText('Retry'));
  expect(mockController.refresh).toHaveBeenCalled();
  fireEvent.press(screen.getByText('Export Markdown'));
  expect(props.onExport).toHaveBeenCalledWith('md');
});

it('creates public links only after an explicit tap', () => {
  mockController.state = { share, invitations: [] };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Anyone with the link can view this note.')).toBeTruthy();
  expect(mockController.setVisibility).not.toHaveBeenCalled();
  fireEvent.press(screen.getByText('Create link'));
  expect(mockController.setVisibility).toHaveBeenCalledWith('link');
});

it('shows the actual invited setting and confirms replacement of an unavailable token', () => {
  mockController.state = {
    share: { ...share, visibility: 'invited', token_prefix: 'abc' },
    invitations: [],
  };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Invited people')).toBeTruthy();
  expect(screen.queryByText('Create link')).toBeNull();
  fireEvent.press(screen.getByText('Replace link'));
  const buttons = (Alert.alert as jest.Mock).mock.calls[0][2];
  expect((Alert.alert as jest.Mock).mock.calls[0][1]).toContain('previous link will stop working');
  buttons[1].onPress();
  expect(mockController.replaceLink).toHaveBeenCalled();
});

it('lets a manager replace a known link and shows a busy status', () => {
  mockController.state = {
    share: { ...share, visibility: 'link', token_prefix: 'abc' },
    invitations: [],
  };
  mockController.hasToken = true;
  mockController.busy = true;
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Updating sharing…')).toBeTruthy();
  expect(screen.getByText('Replace link')).toBeTruthy();
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
  mockController.hasToken = true;
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.queryByText('Share link')).toBeNull();
  expect(screen.queryByText('Replace link')).toBeNull();
  expect(screen.getByText('Export Markdown')).toBeTruthy();
});

it('allows legacy sharing revocation when the share endpoint authorizes access', () => {
  mockController.note = { ...mockController.note!, isPrivate: 1 };
  mockController.state = { share: { ...share, visibility: 'link' }, invitations: [] };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText('Disable previous link')).toBeTruthy();
});

it('confirms before widening a restricted share to anyone with the link', () => {
  mockController.state = {
    share: { ...share, visibility: 'invited', token_prefix: 'abc' },
    invitations: [],
  };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByText('Anyone with link'));
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
  };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByLabelText('Invited only').props.accessibilityState).toMatchObject({
    selected: true,
  });
  expect(screen.getByLabelText('Anyone with link').props.accessibilityState).toMatchObject({
    selected: false,
  });
});

it('shows paused direct access after external sharing is disabled', () => {
  mockController.state = {
    share,
    invitations: [
      {
        id: 'inv-1',
        email: 'pending@example.com',
        invited_by_user_id: 'owner',
        accepted_at: null,
        revoked_at: null,
        last_emailed_at: null,
        created_at: '',
      },
    ],
  };
  const screen = render(<NoteShareSheet {...props} />);
  expect(screen.getByText(/Pending invitation · Paused/)).toBeTruthy();
});

it('confirms before widening invited-only sharing to the organization', () => {
  mockController.state = {
    share: { ...share, visibility: 'invited', token_prefix: 'abc' },
    invitations: [],
  };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByText('Organization (example.com)'));
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
  };
  const screen = render(<NoteShareSheet {...props} />);
  fireEvent.press(screen.getByText('Invited only'));
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(mockController.setVisibility).toHaveBeenCalledWith('invited');
});
