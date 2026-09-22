import { api, ApiError } from '@/lib/apiClient';
import type {
  AccessPrincipalSuggestion,
  CreateAccessGrantInput,
  CreateInvitationsResponse,
  NoteAccessGrant,
  NoteAccessState,
  NotePermission,
  RotateTokenResponse,
  ShareMutationResponse,
  ShareSettings,
  ShareStateResponse,
  ShareVisibility,
} from './noteSharingTypes';

export type NoteSharingRequestOptions = { signal?: AbortSignal };

function sharePath(remoteId: string, suffix = ''): string {
  return `/api/notes/${encodeURIComponent(remoteId)}/share${suffix}`;
}

function accessPath(remoteId: string, suffix = ''): string {
  return `/api/notes/${encodeURIComponent(remoteId)}/access${suffix}`;
}

export async function getNoteShareState(
  remoteId: string,
  options?: NoteSharingRequestOptions,
): Promise<ShareStateResponse> {
  const state = await api.get<ShareStateResponse>(sharePath(remoteId), options);
  if (state.access) return state;
  try {
    return { ...state, access: await getNoteAccessState(remoteId, options) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return state;
    throw error;
  }
}

export async function setNoteShareVisibility(
  remoteId: string,
  visibility: ShareVisibility,
  domainAllowlist: string[],
  options?: NoteSharingRequestOptions,
): Promise<ShareMutationResponse> {
  return api.patch<ShareMutationResponse>(
    sharePath(remoteId),
    { visibility, domain_allowlist: domainAllowlist },
    options,
  );
}

export async function disableNoteShare(
  remoteId: string,
  options?: NoteSharingRequestOptions,
): Promise<{ share: ShareSettings }> {
  return api.delete<{ share: ShareSettings }>(sharePath(remoteId), undefined, options);
}

export async function replaceNoteShareToken(
  remoteId: string,
  options?: NoteSharingRequestOptions,
): Promise<RotateTokenResponse> {
  return api.post<RotateTokenResponse>(sharePath(remoteId, '/rotate-token'), undefined, options);
}

export async function getNoteAccessState(
  remoteId: string,
  options?: NoteSharingRequestOptions,
): Promise<NoteAccessState> {
  return api.get<NoteAccessState>(accessPath(remoteId), options);
}

export async function searchNoteAccessPrincipals(
  remoteId: string,
  query: string,
  options?: NoteSharingRequestOptions,
): Promise<{ suggestions: AccessPrincipalSuggestion[] }> {
  return api.get<{ suggestions: AccessPrincipalSuggestion[] }>(
    accessPath(remoteId, `/suggestions?q=${encodeURIComponent(query)}`),
    options,
  );
}

export async function createNoteAccessGrant(
  remoteId: string,
  input: CreateAccessGrantInput,
  options?: NoteSharingRequestOptions,
): Promise<NoteAccessGrant> {
  return api.post<NoteAccessGrant>(accessPath(remoteId, '/grants'), input, options);
}

export async function updateNoteAccessGrant(
  remoteId: string,
  grantId: string,
  permission: Exclude<NotePermission, 'owner'>,
  options?: NoteSharingRequestOptions,
): Promise<NoteAccessGrant> {
  return api.patch<NoteAccessGrant>(
    accessPath(remoteId, `/grants/${encodeURIComponent(grantId)}`),
    { permission },
    options,
  );
}

export async function removeNoteAccessGrant(
  remoteId: string,
  grantId: string,
  options?: NoteSharingRequestOptions,
): Promise<void> {
  await api.delete<void>(
    accessPath(remoteId, `/grants/${encodeURIComponent(grantId)}`),
    undefined,
    options,
  );
}

export async function inviteNoteEmails(
  remoteId: string,
  emails: string[],
  options?: NoteSharingRequestOptions,
): Promise<CreateInvitationsResponse> {
  return api.post<CreateInvitationsResponse>(
    sharePath(remoteId, '/invitations'),
    { emails },
    options,
  );
}

export async function revokeNoteInvitation(
  remoteId: string,
  invitationId: string,
  options?: NoteSharingRequestOptions,
): Promise<void> {
  await api.delete<void>(
    sharePath(remoteId, `/invitations/${encodeURIComponent(invitationId)}`),
    undefined,
    options,
  );
}

export async function resendNoteInvitation(
  remoteId: string,
  invitationId: string,
  options?: NoteSharingRequestOptions,
): Promise<{ id: string; resent: boolean }> {
  return api.post<{ id: string; resent: boolean }>(
    sharePath(remoteId, `/invitations/${encodeURIComponent(invitationId)}/resend`),
    undefined,
    options,
  );
}
