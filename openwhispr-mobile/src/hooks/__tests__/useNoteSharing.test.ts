import { act, renderHook, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';
import type { Note } from '@/data';

jest.mock('@/store/useAuthStore', () => ({
  useAuthStore: require('zustand').create(() => ({
    user: { id: 'owner', email: 'owner@company.com' },
    sessionCookie: 'cookie',
    isGuest: false,
    isLoading: false,
  })),
}));
jest.mock('@/store/useNotesStore', () => ({
  useNotesStore: require('zustand').create(() => ({ notes: [] })),
}));
jest.mock('@/data', () => ({ notesRepository: { getNoteById: jest.fn() } }));
jest.mock('@/sync/ensureNoteSynced', () => ({ ensureNoteSynced: jest.fn() }));
jest.mock('@/sync/syncEngine', () => ({ requestSync: jest.fn() }));
jest.mock('@/lib/apiClient', () => ({ ApiError: class extends Error {} }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('@/lib/notes/noteShareTokens', () => ({
  readNoteShareToken: jest.fn(),
  saveNoteShareToken: jest.fn(),
  removeNoteShareToken: jest.fn(),
  buildNoteShareUrl: (token: string): string => `https://notes.openwhispr.com/n/${token}`,
}));
jest.mock('@/data/remote/noteSharingApi', () => ({
  getNoteShareState: jest.fn(),
  setNoteShareVisibility: jest.fn(),
  disableNoteShare: jest.fn(),
  replaceNoteShareToken: jest.fn(),
  searchNoteAccessPrincipals: jest.fn(),
  createNoteAccessGrant: jest.fn(),
  updateNoteAccessGrant: jest.fn(),
  removeNoteAccessGrant: jest.fn(),
  inviteNoteEmails: jest.fn(),
  revokeNoteInvitation: jest.fn(),
  resendNoteInvitation: jest.fn(),
}));
import * as sharing from '@/data/remote/noteSharingApi';
import * as tokens from '@/lib/notes/noteShareTokens';
import { notesRepository } from '@/data';
import { useAuthStore } from '@/store/useAuthStore';
import { useNotesStore } from '@/store/useNotesStore';
import { ensureNoteSynced } from '@/sync/ensureNoteSynced';
import { useNoteSharing } from '../useNoteSharing';

const share = {
  visibility: 'private' as const,
  token_prefix: null,
  domain_allowlist: [],
  updated_by_user_id: null,
  updated_at: null,
};
const access = {
  owner: {
    type: 'user' as const,
    id: 'owner',
    email: 'owner@company.com',
    name: 'Owner',
    image: null,
    member_count: null,
  },
  grants: [],
  my_permission: 'owner' as const,
  can_manage_access: true,
  can_manage_inherited_access: true,
};
const TOKEN = 'ow_share_abcdefghijklmnopqrstuvwxyz123456';
let note: Note;
const flushDraft = jest.fn();
function setup(): ReturnType<typeof renderHook<ReturnType<typeof useNoteSharing>, unknown>> {
  return renderHook(() => useNoteSharing(1, true, flushDraft));
}
beforeEach((): void => {
  jest.clearAllMocks();
  jest.mocked(tokens.removeNoteShareToken).mockResolvedValue(undefined);
  jest.mocked(tokens.saveNoteShareToken).mockResolvedValue(undefined);
  note = {
    id: 1,
    clientNoteId: 'client',
    remoteId: 'remote',
    isPrivate: 0,
    title: 'Test note',
    deletedAt: null,
  } as Note;
  jest.mocked(notesRepository.getNoteById).mockImplementation(() => note);
  useNotesStore.setState({ notes: [note] });
  useAuthStore.setState({
    user: { id: 'owner', email: 'owner@company.com' } as NonNullable<
      ReturnType<typeof useAuthStore.getState>['user']
    >,
    sessionCookie: 'cookie',
    isGuest: false,
    isLoading: false,
  });
  jest.mocked(sharing.getNoteShareState).mockResolvedValue({ share, invitations: [], access });
  jest.mocked(tokens.readNoteShareToken).mockResolvedValue(null);
  jest.mocked(ensureNoteSynced).mockResolvedValue('remote');
  jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.dismissedAction });
});
it('only loads settings when opened', async (): Promise<void> => {
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.state?.share.visibility).toBe('private');
  expect(ensureNoteSynced).not.toHaveBeenCalled();
  expect(sharing.setNoteShareVisibility).not.toHaveBeenCalled();
  expect(sharing.replaceNoteShareToken).not.toHaveBeenCalled();
});
it('flushes and syncs before creating a public link; cancelling OS share leaves it active', async (): Promise<void> => {
  const publicShare = { ...share, visibility: 'link' as const, token_prefix: TOKEN.slice(0, 16) };
  jest
    .mocked(sharing.setNoteShareVisibility)
    .mockResolvedValue({ share: publicShare, raw_token: TOKEN });
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.setVisibility('link');
  });
  expect(flushDraft.mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(ensureNoteSynced).mock.invocationCallOrder[0],
  );
  expect(jest.mocked(ensureNoteSynced).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(sharing.setNoteShareVisibility).mock.invocationCallOrder[0],
  );
  expect(tokens.saveNoteShareToken).toHaveBeenCalledWith('owner', 'remote', TOKEN);
  expect(result.current.state?.share.visibility).toBe('link');
  expect(Share.share).toHaveBeenCalled();
  expect(sharing.disableNoteShare).not.toHaveBeenCalled();
});
it('does not rotate an existing link when the token is unavailable', async (): Promise<void> => {
  jest.mocked(sharing.getNoteShareState).mockResolvedValue({
    share: { ...share, visibility: 'link', token_prefix: TOKEN.slice(0, 16) },
    invitations: [],
    access,
  });
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.copyLink();
  });
  expect(sharing.replaceNoteShareToken).not.toHaveBeenCalled();
  expect(result.current.error).toMatch(/replace/i);
});
it('revokes external sharing without requiring content sync', async (): Promise<void> => {
  note = { ...note, conflictServerNote: '{}' };
  jest.mocked(sharing.disableNoteShare).mockResolvedValue({ share });
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.setVisibility('private');
  });
  expect(sharing.disableNoteShare).toHaveBeenCalled();
  expect(ensureNoteSynced).not.toHaveBeenCalled();
});
it('prevents mutation after permission is revoked', async (): Promise<void> => {
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  jest
    .mocked(sharing.getNoteShareState)
    .mockResolvedValue({ share, invitations: [], access: { ...access, can_manage_access: false } });
  await act(async (): Promise<void> => {
    await result.current.setVisibility('link');
  });
  expect(sharing.setNoteShareVisibility).not.toHaveBeenCalled();
  expect(result.current.error).toMatch(/permission/i);
});
it('ignores a delayed settings response after logout', async (): Promise<void> => {
  let finish!: (value: Awaited<ReturnType<typeof sharing.getNoteShareState>>) => void;
  jest.mocked(sharing.getNoteShareState).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result } = setup();
  await act(async (): Promise<void> => {
    useAuthStore.setState({ user: null });
    finish({ share, invitations: [], access });
  });
  expect(result.current.state).toBeNull();
});
it('can inspect old cloud sharing but cannot publish a private note', async (): Promise<void> => {
  note = { ...note, isPrivate: 1 };
  useNotesStore.setState({ notes: [note] });
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(sharing.getNoteShareState).toHaveBeenCalled();
  await act(async (): Promise<void> => {
    await result.current.setVisibility('link');
  });
  expect(sharing.setNoteShareVisibility).not.toHaveBeenCalled();
});
it('uses ACL grants for email invitations when supported', async (): Promise<void> => {
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.inviteEmail(' Friend@Example.com ');
  });
  expect(sharing.createNoteAccessGrant).toHaveBeenCalledWith(
    'remote',
    { principal_type: 'email', email: 'friend@example.com', permission: 'viewer' },
    expect.anything(),
  );
  expect(sharing.inviteNoteEmails).not.toHaveBeenCalled();
});

it('keeps confirmed sharing active if secure storage fails', async (): Promise<void> => {
  jest.mocked(sharing.setNoteShareVisibility).mockResolvedValue({
    share: { ...share, visibility: 'link', token_prefix: TOKEN.slice(0, 16) },
    raw_token: TOKEN,
  });
  jest
    .mocked(tokens.saveNoteShareToken)
    .mockRejectedValueOnce(new Error('Device storage unavailable'));
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.setVisibility('link');
  });
  expect(result.current.state?.share.visibility).toBe('link');
  expect(result.current.error).toMatch(/storage/i);
  expect(sharing.disableNoteShare).not.toHaveBeenCalled();
  expect(sharing.replaceNoteShareToken).not.toHaveBeenCalled();
});
it('rejects cached tokens replaced on another device', async (): Promise<void> => {
  jest.mocked(tokens.readNoteShareToken).mockResolvedValue(TOKEN);
  jest.mocked(sharing.getNoteShareState).mockResolvedValue({
    share: { ...share, visibility: 'link', token_prefix: 'ow_share_NEW' },
    invitations: [],
    access,
  });
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.hasToken).toBe(false);
  expect(tokens.removeNoteShareToken).toHaveBeenCalledWith('owner', 'remote');
});
it('cannot modify inherited scope access even with group management permission', async (): Promise<void> => {
  const grant = {
    id: 'scope:team',
    principal: { ...access.owner, type: 'team' as const },
    permission: 'viewer' as const,
    inherited: true,
    source: 'team' as const,
    pending: false,
    created_at: 'now',
    updated_at: 'now',
  };
  jest
    .mocked(sharing.getNoteShareState)
    .mockResolvedValue({ share, invitations: [], access: { ...access, grants: [grant] } });
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.updateGrant(grant, 'editor');
  });
  expect(sharing.updateNoteAccessGrant).not.toHaveBeenCalled();
  expect(result.current.error).toMatch(/inherited/i);
});
it('reports legacy invitation delivery failure without sending twice', async (): Promise<void> => {
  jest.mocked(sharing.getNoteShareState).mockResolvedValue({ share, invitations: [] });
  jest
    .mocked(sharing.inviteNoteEmails)
    .mockResolvedValue({ created: [], already_invited: [], email_failed_ids: ['invitation'] });
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.inviteEmail('friend@example.com');
  });
  expect(sharing.inviteNoteEmails).toHaveBeenCalledTimes(1);
  expect(result.current.message).toMatch(/delivery failed/i);
});
it('does not duplicate existing invitations with different email casing', async (): Promise<void> => {
  jest.mocked(sharing.getNoteShareState).mockResolvedValue({
    share,
    invitations: [
      {
        id: 'invite',
        email: 'Friend@Example.com',
        revoked_at: null,
        accepted_at: null,
        created_at: 'now',
        last_emailed_at: null,
        invited_by_user_id: 'owner',
      },
    ],
    access,
  });
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.inviteEmail('friend@example.com');
  });
  expect(sharing.createNoteAccessGrant).not.toHaveBeenCalled();
  expect(result.current.error).toMatch(/already/i);
});
it('ignores a mutation result after privacy opt-out', async (): Promise<void> => {
  let finish!: (value: Awaited<ReturnType<typeof sharing.setNoteShareVisibility>>) => void;
  jest.mocked(sharing.setNoteShareVisibility).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.setVisibility('link');
  });
  await waitFor(() => expect(sharing.setNoteShareVisibility).toHaveBeenCalled());
  await act(async (): Promise<void> => {
    note = { ...note, isPrivate: 1 };
    useNotesStore.setState({ notes: [note] });
  });
  await act(async (): Promise<void> => {
    finish({ share: { ...share, visibility: 'link' }, raw_token: TOKEN });
    await pending;
  });
  expect(tokens.saveNoteShareToken).not.toHaveBeenCalled();
  expect(result.current.state?.share.visibility).not.toBe('link');
});
it('requires a paired viewer before uploading to a custom API', async (): Promise<void> => {
  const previousApi = process.env.EXPO_PUBLIC_API_URL;
  process.env.EXPO_PUBLIC_API_URL = 'https://api.example.com';
  try {
    const { result } = setup();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async (): Promise<void> => {
      await result.current.setVisibility('link');
    });
    expect(ensureNoteSynced).not.toHaveBeenCalled();
    expect(sharing.setNoteShareVisibility).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/EXPO_PUBLIC_NOTES_URL/);
  } finally {
    if (previousApi === undefined) delete process.env.EXPO_PUBLIC_API_URL;
    else process.env.EXPO_PUBLIC_API_URL = previousApi;
  }
});

it('keeps a issued token and confirmed access if post-share sync times out', async (): Promise<void> => {
  jest.mocked(sharing.setNoteShareVisibility).mockResolvedValue({
    share: { ...share, visibility: 'link', updated_at: '2026-09-22T12:00:00Z' },
    raw_token: TOKEN,
  });
  jest
    .mocked(ensureNoteSynced)
    .mockResolvedValueOnce('remote')
    .mockRejectedValueOnce(new Error('Sync timed out'));
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.setVisibility('link');
  });
  expect(tokens.saveNoteShareToken).toHaveBeenCalledWith('owner', 'remote', TOKEN);
  expect(result.current.hasToken).toBe(true);
  expect(result.current.state?.share.visibility).toBe('link');
  expect(result.current.error).toMatch(/timed out/i);
  expect(Share.share).not.toHaveBeenCalled();
});

it('can disable an old external link after local cloud sync opt-out', async (): Promise<void> => {
  note = { ...note, isPrivate: 1 };
  useNotesStore.setState({ notes: [note] });
  jest.mocked(sharing.disableNoteShare).mockResolvedValue({ share });
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.setVisibility('private');
  });
  expect(sharing.disableNoteShare).toHaveBeenCalledWith('remote', expect.anything());
  expect(ensureNoteSynced).not.toHaveBeenCalled();
  expect(flushDraft).not.toHaveBeenCalled();
});
it('clears unconfirmed sharing state after a lost mutation response', async (): Promise<void> => {
  jest
    .mocked(sharing.setNoteShareVisibility)
    .mockRejectedValueOnce(new Error('Network request failed'));
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async (): Promise<void> => {
    await result.current.setVisibility('link');
  });
  expect(result.current.state).toBeNull();
  expect(result.current.error).toMatch(/refresh settings/i);
  expect(sharing.setNoteShareVisibility).toHaveBeenCalledTimes(1);
});
it('reports ACL invitation delivery failure after reading fresh invitations', async (): Promise<void> => {
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  jest
    .mocked(sharing.getNoteShareState)
    .mockResolvedValueOnce({ share, invitations: [], access })
    .mockResolvedValueOnce({
      share,
      access,
      invitations: [
        {
          id: 'invite',
          email: 'friend@example.com',
          revoked_at: null,
          accepted_at: null,
          last_emailed_at: null,
          created_at: 'now',
          invited_by_user_id: 'owner',
        },
      ],
    });
  await act(async (): Promise<void> => {
    await result.current.inviteEmail('friend@example.com');
  });
  expect(result.current.message).toMatch(/email was not sent/i);
  expect(sharing.createNoteAccessGrant).toHaveBeenCalledTimes(1);
});

it('requires refreshing access after a confirmed grant cannot be reloaded', async (): Promise<void> => {
  const { result } = setup();
  await waitFor(() => expect(result.current.loading).toBe(false));
  jest
    .mocked(sharing.getNoteShareState)
    .mockResolvedValueOnce({ share, invitations: [], access })
    .mockRejectedValueOnce(new Error('Network down'));
  await act(async (): Promise<void> => {
    await result.current.inviteEmail('friend@example.com');
  });
  expect(sharing.createNoteAccessGrant).toHaveBeenCalledTimes(1);
  expect(result.current.state).toBeNull();
  expect(result.current.message).toBeNull();
  expect(result.current.error).toMatch(/sharing changed.*refresh/i);
});
