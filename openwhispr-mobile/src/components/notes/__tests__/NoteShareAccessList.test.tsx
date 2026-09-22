import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { NoteAccessState, NoteShareInvitation } from '@/data/remote/noteSharingTypes';
import { NoteShareAccessList } from '../NoteShareAccessList';

const mockSearch = jest.fn();
jest.mock('@/data/remote/noteSharingApi', () => ({
  searchNoteAccessPrincipals: (...args: unknown[]) => mockSearch(...args),
}));

jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

const owner = {
  type: 'user' as const,
  id: 'owner',
  email: 'owner@example.com',
  name: 'Owner',
  image: null,
  member_count: null,
};
const access: NoteAccessState = {
  owner,
  grants: [
    {
      id: 'grant-1',
      principal: { ...owner, id: 'person', email: 'person@example.com', name: 'Person' },
      permission: 'viewer',
      source: 'direct',
      inherited: false,
      pending: false,
      created_at: '',
      updated_at: '',
    },
  ],
  my_permission: 'owner',
  can_manage_access: true,
  can_manage_inherited_access: false,
};
const invitation: NoteShareInvitation = {
  id: 'inv-1',
  email: 'pending@example.com',
  invited_by_user_id: 'owner',
  accepted_at: null,
  revoked_at: null,
  last_emailed_at: null,
  created_at: '',
};

it('shows owner, grants, and pending invitations, and forwards permitted changes', () => {
  const updateGrant = jest.fn();
  const revokeInvitation = jest.fn();
  const screen = render(
    <NoteShareAccessList
      access={access}
      invitations={[invitation]}
      busy={false}
      onUpdateGrant={updateGrant}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={revokeInvitation}
      onResendInvitation={jest.fn()}
    />,
  );
  expect(screen.getAllByText('Owner')).toHaveLength(2);
  expect(screen.getByText('Person')).toBeTruthy();
  expect(screen.getByText('Viewer · Direct')).toBeTruthy();
  expect(screen.getByText('pending@example.com')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Make Person an editor'));
  expect(updateGrant).toHaveBeenCalledWith(access.grants[0], 'editor');
  fireEvent.press(screen.getByLabelText('Revoke invitation for pending@example.com'));
  expect(revokeInvitation).toHaveBeenCalledWith(invitation);
});

it('keeps inherited grants read-only and invitation actions visible beside invite grants', () => {
  const inherited = {
    ...access.grants[0],
    id: 'inherited',
    inherited: true,
    source: 'team' as const,
  };
  const screen = render(
    <NoteShareAccessList
      access={{
        ...access,
        can_manage_inherited_access: true,
        grants: [
          inherited,
          {
            ...access.grants[0],
            id: 'invite:inv-1',
            pending: true,
            principal: {
              ...access.grants[0].principal,
              name: 'Pending Person',
              email: 'pending@example.com',
            },
          },
        ],
      }}
      invitations={[invitation]}
      busy={false}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  expect(screen.queryByLabelText('Make Person an editor')).toBeNull();
  expect(screen.getByLabelText('Revoke invitation for pending@example.com')).toBeTruthy();
  expect(screen.getByLabelText('Make pending@example.com an editor')).toBeTruthy();
  expect(screen.getByLabelText('Resend invitation to pending@example.com')).toBeTruthy();
  expect(screen.queryByText('Pending Person')).toBeNull();
});

it('searches principals and only offers grants allowed by server permissions', async () => {
  jest.useFakeTimers();
  mockSearch.mockResolvedValue({
    suggestions: [
      {
        type: 'user',
        id: 'user-2',
        name: 'Jamie',
        email: 'jamie@example.com',
        image: null,
        member_count: null,
        existing_grant_id: null,
      },
      {
        type: 'team',
        id: 'team-2',
        name: 'Engineering',
        email: null,
        image: null,
        member_count: 3,
        existing_grant_id: null,
      },
    ],
  });
  const onAddPrincipal = jest.fn();
  const screen = render(
    <NoteShareAccessList
      remoteId="remote-1"
      access={access}
      invitations={[]}
      busy={false}
      onAddPrincipal={onAddPrincipal}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  fireEvent.changeText(screen.getByLabelText('Find people or groups'), 'jam');
  await act(async () => {
    jest.advanceTimersByTime(350);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText('Jamie')).toBeTruthy());
  expect(screen.queryByText('Engineering')).toBeNull();
  fireEvent.press(screen.getByText('Jamie'));
  expect(onAddPrincipal).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-2' }));
  onAddPrincipal.mockClear();
  screen.rerender(
    <NoteShareAccessList
      remoteId="remote-1"
      access={access}
      invitations={[]}
      busy
      onAddPrincipal={onAddPrincipal}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  fireEvent.changeText(screen.getByLabelText('Find people or groups'), 'jam');
  await act(async () => {
    jest.advanceTimersByTime(350);
    await Promise.resolve();
  });
  fireEvent.press(screen.getByText('Jamie'));
  expect(onAddPrincipal).not.toHaveBeenCalled();
  jest.useRealTimers();
});
