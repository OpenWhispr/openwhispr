jest.mock('@/lib/apiClient', () => ({
  ApiError: class extends Error {
    status: number;
    constructor(message: string, errorStatus: number) {
      super(message);
      this.status = errorStatus;
    }
  },
  api: { get: jest.fn(), patch: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));

import { api, ApiError } from '@/lib/apiClient';
import {
  getNoteShareState,
  setNoteShareVisibility,
  disableNoteShare,
  replaceNoteShareToken,
  getNoteAccessState,
  searchNoteAccessPrincipals,
  createNoteAccessGrant,
  updateNoteAccessGrant,
  removeNoteAccessGrant,
  inviteNoteEmails,
  revokeNoteInvitation,
  resendNoteInvitation,
} from '../noteSharingApi';

const mockApi = jest.mocked(api);
const options = { signal: new AbortController().signal };

beforeEach(() => jest.clearAllMocks());

it('gets share settings and access when absent in the response', async () => {
  mockApi.get.mockResolvedValueOnce({ share: { visibility: 'link' }, invitations: [] });
  mockApi.get.mockResolvedValueOnce({ grants: [] });
  await expect(getNoteShareState('note/id', options)).resolves.toMatchObject({
    access: { grants: [] },
  });
  expect(mockApi.get).toHaveBeenNthCalledWith(1, '/api/notes/note%2Fid/share', options);
  expect(mockApi.get).toHaveBeenNthCalledWith(2, '/api/notes/note%2Fid/access', options);
});

it('keeps legacy share response only when ACL explicitly returns 404', async () => {
  const state = { share: { visibility: 'link' }, invitations: [] };
  mockApi.get.mockResolvedValueOnce(state).mockRejectedValueOnce(new ApiError('missing', 404));
  await expect(getNoteShareState('id')).resolves.toEqual(state);
  mockApi.get.mockResolvedValueOnce(state).mockRejectedValueOnce(new ApiError('blocked', 403));
  await expect(getNoteShareState('id')).rejects.toMatchObject({ status: 403 });
});

it('preserves returned raw token and writes expected share endpoints', async () => {
  const response = { share: { visibility: 'link' }, raw_token: null };
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
  await getNoteAccessState('note/id', options);
  await searchNoteAccessPrincipals('note/id', 'a+b', options);
  const input = {
    principal_type: 'email' as const,
    email: 'a@example.com',
    permission: 'viewer' as const,
  };
  await createNoteAccessGrant('note/id', input, options);
  await updateNoteAccessGrant('note/id', 'grant/id', 'editor', options);
  await removeNoteAccessGrant('note/id', 'grant/id', options);
  await inviteNoteEmails('note/id', ['a@example.com'], options);
  await revokeNoteInvitation('note/id', 'inv/id', options);
  await resendNoteInvitation('note/id', 'inv/id', options);
  expect(mockApi.get).toHaveBeenCalledWith('/api/notes/note%2Fid/access', options);
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
  expect(mockApi.post).toHaveBeenCalledWith(
    '/api/notes/note%2Fid/share/invitations',
    { emails: ['a@example.com'] },
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
