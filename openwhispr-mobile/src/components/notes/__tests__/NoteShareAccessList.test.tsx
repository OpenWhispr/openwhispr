import { Alert, type AlertButton } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import type { NoteAccessState, NoteShareInvitation } from '@/data/remote/noteSharingTypes';
import { NoteShareAccessList } from '../NoteShareAccessList';

jest.mock('@react-native-menu/menu', () => require('./menuViewMock'));
jest.mock('@/components/ui/Text', () => ({ Text: require('react-native').Text }));
jest.mock('@/components/ui/SystemIcon', () => ({ SystemIcon: () => null }));

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Presses the named button of the most recent confirmation. */
function confirmAlert(action: string): void {
  const buttons = (Alert.alert as jest.Mock).mock.lastCall[2] as AlertButton[];
  buttons.find((button) => button.text === action)?.onPress?.();
}

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
  permission: 'viewer',
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
  expect(screen.getByText('person@example.com')).toBeTruthy();
  expect(screen.getByLabelText('Change access for Person').props.accessibilityValue).toEqual({
    text: 'Viewer',
  });
  expect(screen.getByText('pending@example.com')).toBeTruthy();
  fireEvent.press(screen.getByTestId('menu-grant-1:viewer'));
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(updateGrant).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('menu-grant-1:editor'));
  expect(updateGrant).not.toHaveBeenCalled();
  confirmAlert('Make editor');
  expect(updateGrant).toHaveBeenCalledWith(access.grants[0], 'editor');
  fireEvent.press(screen.getByTestId('menu-invitation:inv-1:revoke'));
  expect(revokeInvitation).not.toHaveBeenCalled();
  confirmAlert('Cancel');
  expect(revokeInvitation).not.toHaveBeenCalled();
  fireEvent.press(screen.getByTestId('menu-invitation:inv-1:revoke'));
  confirmAlert('Revoke');
  expect(revokeInvitation).toHaveBeenCalledWith(invitation);
});

it('keeps inherited grants read-only and invitation actions visible beside invite grants', () => {
  const inherited = {
    ...access.grants[0],
    id: 'scope:workspace:00000000-0000-4000-8000-000000000001',
    inherited: true,
    source: 'workspace' as const,
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
  expect(screen.queryByLabelText('Change access for Person')).toBeNull();
  expect(screen.getByTestId('menu-invitation:inv-1:revoke')).toBeTruthy();
  expect(screen.getByTestId('menu-invitation:inv-1:editor')).toBeTruthy();
  expect(screen.getByTestId('menu-invitation:inv-1:resend')).toBeTruthy();
  expect(screen.queryByText('Pending Person')).toBeNull();
});

const teamGrant = {
  ...access.grants[0],
  id: 'grant-team',
  principal: { ...owner, type: 'team' as const, id: 'team-1', email: null, name: 'Design' },
  inherited: true,
  source: 'team' as const,
};
it.each([
  [true, true],
  [false, false],
])(
  'lets group managers change stored team grants (can manage inherited: %s)',
  (canManageInherited, editable) => {
    const removeGrant = jest.fn();
    const screen = render(
      <NoteShareAccessList
        access={{ ...access, can_manage_inherited_access: canManageInherited, grants: [teamGrant] }}
        invitations={[]}
        busy={false}
        onUpdateGrant={jest.fn()}
        onRemoveGrant={removeGrant}
        onRevokeInvitation={jest.fn()}
        onResendInvitation={jest.fn()}
      />,
    );
    if (editable) {
      expect(screen.getByText('Team')).toBeTruthy();
      fireEvent.press(screen.getByTestId('menu-grant-team:remove'));
      expect(removeGrant).not.toHaveBeenCalled();
      confirmAlert('Remove');
      expect(removeGrant).toHaveBeenCalledWith(teamGrant);
    } else {
      expect(screen.queryByTestId('menu-grant-team:remove')).toBeNull();
    }
  },
);

it('marks direct access and invitations as paused while external sharing is off', () => {
  const screen = render(
    <NoteShareAccessList
      access={access}
      invitations={[invitation]}
      paused
      busy={false}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  expect(screen.getByText(/paused until you share this note again/i)).toBeTruthy();
  expect(screen.getByText('person@example.com · Paused')).toBeTruthy();
  expect(screen.getByText(/Pending invitation · Paused/)).toBeTruthy();
});

const scopeGrant = {
  ...access.grants[0],
  id: 'scope:space:1',
  principal: { ...owner, type: 'space' as const, id: 'space', email: null, name: 'Design space' },
  source: 'space' as const,
  inherited: true,
};

it('stops offering Resend while sharing is paused, since the email could not open the note', () => {
  const screen = render(
    <NoteShareAccessList
      access={access}
      invitations={[invitation]}
      paused
      busy={false}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  expect(screen.queryByTestId('menu-invitation:inv-1:resend')).toBeNull();
  expect(screen.getByTestId('menu-invitation:inv-1:revoke')).toBeTruthy();
});

it('never marks team-space membership as paused', () => {
  const screen = render(
    <NoteShareAccessList
      access={{ ...access, grants: [scopeGrant] }}
      invitations={[]}
      paused
      busy={false}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  expect(screen.getByText('Inherited from team space')).toBeTruthy();
  expect(screen.queryByLabelText('Change access for Design space')).toBeNull();
});

it('keeps only removals when the organization blocks invitations', () => {
  const screen = render(
    <NoteShareAccessList
      access={access}
      invitations={[invitation]}
      canInvite={false}
      busy={false}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  expect(screen.queryByTestId('menu-grant-1:editor')).toBeNull();
  expect(screen.queryByTestId('menu-invitation:inv-1:resend')).toBeNull();
  expect(screen.getByTestId('menu-grant-1:remove')).toBeTruthy();
  expect(screen.getByTestId('menu-invitation:inv-1:revoke')).toBeTruthy();
});

it('shows an invitation permission from the invitation itself', () => {
  const screen = render(
    <NoteShareAccessList
      access={access}
      invitations={[{ ...invitation, permission: 'editor' }]}
      busy={false}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  expect(
    screen.getByLabelText('Change access for pending@example.com').props.accessibilityValue,
  ).toEqual({ text: 'Editor' });
});

it('gives every menu a 44pt touch target and greys out its actions while busy', () => {
  const screen = render(
    <NoteShareAccessList
      access={access}
      invitations={[invitation]}
      busy
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  for (const label of ['Change access for Person', 'Change access for pending@example.com']) {
    const trigger = screen.getByLabelText(label);
    expect(trigger.props.className).toContain('min-h-[44px]');
    expect(trigger.props.accessibilityState).toMatchObject({ disabled: true });
  }
  for (const id of [
    'grant-1:editor',
    'grant-1:remove',
    'invitation:inv-1:resend',
    'invitation:inv-1:revoke',
  ]) {
    expect(screen.getByTestId(`menu-${id}`).props.accessibilityState).toMatchObject({
      disabled: true,
    });
  }
});

it('still lets a manager reduce access when the organization blocks invitations', () => {
  const editorGrant = { ...access.grants[0], permission: 'editor' as const };
  const updateGrant = jest.fn();
  const screen = render(
    <NoteShareAccessList
      access={{
        ...access,
        grants: [
          editorGrant,
          {
            ...access.grants[0],
            id: 'invite:inv-1',
            principal: {
              ...owner,
              type: 'email',
              id: null,
              email: 'pending@example.com',
              name: null,
            },
            permission: 'editor' as const,
          },
        ],
      }}
      invitations={[{ ...invitation, permission: 'editor' }]}
      canInvite={false}
      busy={false}
      onUpdateGrant={updateGrant}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  expect(screen.getByTestId('menu-grant-1:editor').props.accessibilityState).toMatchObject({
    selected: true,
  });
  fireEvent.press(screen.getByTestId('menu-grant-1:viewer'));
  expect(Alert.alert).not.toHaveBeenCalled();
  expect(updateGrant).toHaveBeenCalledWith(editorGrant, 'viewer');
  fireEvent.press(screen.getByTestId('menu-invitation:inv-1:viewer'));
  expect(updateGrant).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: 'invite:inv-1' }),
    'viewer',
  );
});

/** VoiceOver can't focus an element inside another accessible element, so nested actions vanish. */
type RenderedElement = ReturnType<ReturnType<typeof render>['getByLabelText']>;
function insideAccessibleElement(element: RenderedElement): boolean {
  for (let node = element.parent; node; node = node.parent) {
    if (typeof node.type === 'string' && node.props.accessible) return true;
  }
  return false;
}
it('leaves per-person menus reachable by VoiceOver', () => {
  const screen = render(
    <NoteShareAccessList
      access={access}
      invitations={[invitation]}
      busy={false}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  for (const label of ['Change access for Person', 'Change access for pending@example.com']) {
    expect(insideAccessibleElement(screen.getByLabelText(label))).toBe(false);
  }
});

it('gives a person without a name the initial of their email', () => {
  const screen = render(
    <NoteShareAccessList
      access={{ ...access, grants: [], owner: { ...owner, name: null, email: 'sam@example.com' } }}
      invitations={[]}
      busy={false}
      onUpdateGrant={jest.fn()}
      onRemoveGrant={jest.fn()}
      onRevokeInvitation={jest.fn()}
      onResendInvitation={jest.fn()}
    />,
  );
  expect(screen.getByText('S')).toBeTruthy();
  expect(screen.getByText('sam@example.com')).toBeTruthy();
});
