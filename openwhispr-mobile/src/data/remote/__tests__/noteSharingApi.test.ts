jest.mock('@/lib/apiClient', () => ({
  api: { get: jest.fn(), patch: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));

import { api } from '@/lib/apiClient';
import {
  getNoteShareState,
  setNoteShareVisibility,
  disableNoteShare,
  replaceNoteShareToken,
  getExternalSharingMode,
  searchNoteAccessPrincipals,
  createNoteAccessGrant,
  updateNoteAccessGrant,
  removeNoteAccessGrant,
  revokeNoteInvitation,
  resendNoteInvitation,
} from '../noteSharingApi';

const mockApi = jest.mocked(api);
const options = { signal: new AbortController().signal };
const share = {
  visibility: 'invited' as const,
  token_prefix: 'ow_share_Ab_9-xY',
  domain_allowlist: [],
  updated_by_user_id: 'owner',
  updated_at: '2026-09-22T00:00:00.000Z',
};

beforeEach(() => jest.clearAllMocks());

it('reads share settings, invitations, and access in one request', async () => {
  const state = {
    share,
    invitations: [],
    access: {
      owner: { type: 'user', id: 'owner', email: 'o@x.com', name: null, image: null },
      grants: [],
      my_permission: 'owner',
      can_manage_access: true,
      can_manage_inherited_access: true,
    },
  };
  mockApi.get.mockResolvedValueOnce(state);
  await expect(getNoteShareState('note/id', options)).resolves.toBe(state);
  expect(mockApi.get).toHaveBeenCalledTimes(1);
  expect(mockApi.get).toHaveBeenCalledWith('/api/notes/note%2Fid/share', options);
});

it('reads the organization external sharing mode, permissive when unmanaged', async () => {
  const policy = (managed: boolean, mode: string) => ({
    data: { managed, policy: { sharing: { externalLinkSharing: mode } }, policyUpdatedAt: null },
  });
  mockApi.get.mockResolvedValueOnce(policy(true, 'domain_only'));
  await expect(getExternalSharingMode(options)).resolves.toBe('domain_only');
  expect(mockApi.get).toHaveBeenCalledWith('/api/workspace-policy', options);
  mockApi.get.mockResolvedValueOnce(policy(false, 'disabled'));
  await expect(getExternalSharingMode()).resolves.toBe('allowed');
});

it('preserves returned raw token and writes expected share endpoints', async () => {
  const response = { share: { ...share, visibility: 'link' as const }, raw_token: null };
  mockApi.patch.mockResolvedValue(response);
  await expect(setNoteShareVisibility('note/id', 'link', [], options)).resolves.toEqual(response);
  expect(mockApi.patch).toHaveBeenCalledWith(
    '/api/notes/note%2Fid/share',
    {
      visibility: 'link',
      domain_allowlist: [],
    },
    options,
  );
  await disableNoteShare('note/id', options);
  expect(mockApi.delete).toHaveBeenCalledWith('/api/notes/note%2Fid/share', undefined, options);
  await replaceNoteShareToken('note/id', options);
  expect(mockApi.post).toHaveBeenCalledWith(
    '/api/notes/note%2Fid/share/rotate-token',
    undefined,
    options,
  );
});

it('routes ACL grants, principal search, and invitations with encoded ids', async () => {
  await searchNoteAccessPrincipals('note/id', 'a+b', options);
  const input = {
    principal_type: 'email' as const,
    email: 'a@example.com',
    permission: 'viewer' as const,
  };
  await createNoteAccessGrant('note/id', input, options);
  await updateNoteAccessGrant('note/id', 'grant/id', 'editor', options);
  await removeNoteAccessGrant('note/id', 'grant/id', options);
  await revokeNoteInvitation('note/id', 'inv/id', options);
  await resendNoteInvitation('note/id', 'inv/id', options);
  expect(mockApi.get).toHaveBeenCalledWith(
    '/api/notes/note%2Fid/access/suggestions?q=a%2Bb',
    options,
  );
  expect(mockApi.post).toHaveBeenCalledWith('/api/notes/note%2Fid/access/grants', input, options);
  expect(mockApi.patch).toHaveBeenCalledWith(
    '/api/notes/note%2Fid/access/grants/grant%2Fid',
    { permission: 'editor' },
    options,
  );
  expect(mockApi.delete).toHaveBeenCalledWith(
    '/api/notes/note%2Fid/access/grants/grant%2Fid',
    undefined,
    options,
  );
  expect(mockApi.delete).toHaveBeenCalledWith(
    '/api/notes/note%2Fid/share/invitations/inv%2Fid',
    undefined,
    options,
  );
  expect(mockApi.post).toHaveBeenCalledWith(
    '/api/notes/note%2Fid/share/invitations/inv%2Fid/resend',
    undefined,
    options,
  );
});
