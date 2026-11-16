import { useState } from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type {
  AccessPrincipalSuggestion,
  NoteAccessState,
  NoteShareInvitation,
} from '@/data/remote/noteSharingTypes';
import { NoteShareInviteField } from '../NoteShareInviteField';

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
  grants: [],
  my_permission: 'owner',
  can_manage_access: true,
  can_manage_inherited_access: false,
};
const jamie: AccessPrincipalSuggestion = {
  type: 'user',
  id: 'user-2',
  name: 'Jamie',
  email: 'jamie@example.com',
  image: null,
  member_count: null,
  existing_grant_id: null,
};
const engineering: AccessPrincipalSuggestion = {
  type: 'team',
  id: 'team-2',
  name: 'Engineering',
  email: null,
  image: null,
  member_count: 3,
  existing_grant_id: null,
};

interface HarnessProps {
  remoteId?: string;
  invitations?: NoteShareInvitation[];
  busy?: boolean;
  onInvite?: () => void;
  onAddPrincipal?: (principal: AccessPrincipalSuggestion) => void;
}

function Harness({ remoteId, invitations, busy = false, onInvite, onAddPrincipal }: HarnessProps) {
  const [value, setValue] = useState('');
  return (
    <NoteShareInviteField
      value={value}
      onChangeText={setValue}
      onInvite={onInvite ?? jest.fn()}
      remoteId={remoteId}
      access={access}
      invitations={invitations}
      busy={busy}
      onAddPrincipal={onAddPrincipal}
    />
  );
}

async function settleSearch(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(350);
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockSearch.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

it('searches principals and only offers grants allowed by server permissions', async () => {
  mockSearch.mockResolvedValue({ suggestions: [jamie, engineering] });
  const onAddPrincipal = jest.fn();
  const screen = render(<Harness remoteId="remote-1" onAddPrincipal={onAddPrincipal} />);
  fireEvent.changeText(screen.getByLabelText('Add people or emails'), 'jam');
  await settleSearch();
  await waitFor(() => expect(screen.getByText('Jamie')).toBeTruthy());
  expect(screen.queryByText('Engineering')).toBeNull();
  fireEvent.press(screen.getByLabelText('Grant access to Jamie'));
  expect(onAddPrincipal).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-2' }));
});

it('does not add anyone while an operation runs', async () => {
  mockSearch.mockResolvedValue({ suggestions: [jamie] });
  const onAddPrincipal = jest.fn();
  const screen = render(<Harness remoteId="remote-1" busy onAddPrincipal={onAddPrincipal} />);
  fireEvent.changeText(screen.getByLabelText('Add people or emails'), 'jam');
  await settleSearch();
  await waitFor(() => expect(screen.getByText('Jamie')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Grant access to Jamie'));
  expect(onAddPrincipal).not.toHaveBeenCalled();
});

it('offers to invite a typed address, from a row or the return key', () => {
  const onInvite = jest.fn();
  const screen = render(
    <Harness remoteId="remote-1" onInvite={onInvite} onAddPrincipal={jest.fn()} />,
  );
  const input = screen.getByLabelText('Add people or emails');
  fireEvent.changeText(input, 'friend@');
  expect(screen.queryByLabelText('Invite friend@')).toBeNull();
  fireEvent.changeText(input, 'friend@example.com');
  fireEvent.press(screen.getByLabelText('Invite friend@example.com'));
  fireEvent(input, 'submitEditing');
  expect(onInvite).toHaveBeenCalledTimes(2);
});

it('does not offer to invite someone who already has access', () => {
  const invitation: NoteShareInvitation = {
    id: 'inv-1',
    email: 'pending@example.com',
    invited_by_user_id: 'owner',
    permission: 'viewer',
    accepted_at: null,
    revoked_at: null,
    last_emailed_at: null,
    created_at: '',
  };
  const screen = render(
    <Harness remoteId="remote-1" invitations={[invitation]} onAddPrincipal={jest.fn()} />,
  );
  const input = screen.getByLabelText('Add people or emails');
  fireEvent.changeText(input, 'Pending@example.com');
  expect(screen.queryByLabelText('Invite Pending@example.com')).toBeNull();
  fireEvent.changeText(input, 'owner@example.com');
  expect(screen.queryByLabelText('Invite owner@example.com')).toBeNull();
});

it('prefers a matching account over a bare invitation', async () => {
  mockSearch.mockResolvedValue({ suggestions: [jamie] });
  const screen = render(<Harness remoteId="remote-1" onAddPrincipal={jest.fn()} />);
  fireEvent.changeText(screen.getByLabelText('Add people or emails'), 'jamie@example.com');
  await settleSearch();
  await waitFor(() => expect(screen.getByText('Jamie')).toBeTruthy());
  expect(screen.queryByLabelText('Invite jamie@example.com')).toBeNull();
});

it('only invites by email before the note has a cloud copy to search', async () => {
  const screen = render(<Harness onAddPrincipal={jest.fn()} />);
  fireEvent.changeText(screen.getByLabelText('Invite by email'), 'friend@example.com');
  await settleSearch();
  expect(mockSearch).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Invite friend@example.com')).toBeTruthy();
});

it('reports a failed search', async () => {
  mockSearch.mockRejectedValue(new Error('offline'));
  const screen = render(<Harness remoteId="remote-1" onAddPrincipal={jest.fn()} />);
  fireEvent.changeText(screen.getByLabelText('Add people or emails'), 'jam');
  await settleSearch();
  await waitFor(() => expect(screen.getByText('Search unavailable. Try again.')).toBeTruthy());
});

it('still offers groups when an existing grant has no email', async () => {
  mockSearch.mockResolvedValue({ suggestions: [engineering] });
  const designGrant = {
    id: 'grant-team',
    principal: { ...owner, type: 'team' as const, id: 'team-1', email: null, name: 'Design' },
    permission: 'viewer' as const,
    source: 'team' as const,
    inherited: true,
    pending: false,
    created_at: '',
    updated_at: '',
  };
  const screen = render(
    <NoteShareInviteField
      value="eng"
      onChangeText={jest.fn()}
      onInvite={jest.fn()}
      remoteId="remote-1"
      access={{ ...access, can_manage_inherited_access: true, grants: [designGrant] }}
      busy={false}
      onAddPrincipal={jest.fn()}
    />,
  );
  await settleSearch();
  await waitFor(() => expect(screen.getByText('Engineering')).toBeTruthy());
});
