import { api } from '@/lib/apiClient';
import type {
  AccessPrincipalSuggestion,
  CreateAccessGrantInput,
  ExternalSharingMode,
  NoteAccessGrant,
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
  return api.get<ShareStateResponse>(sharePath(remoteId), options);
}

/** The strictest external-sharing mode across the caller's workspaces; the server still enforces it. */
export async function getExternalSharingMode(
  options?: NoteSharingRequestOptions,
): Promise<ExternalSharingMode> {
  const { data } = await api.get<{
    data: { managed: boolean; policy: { sharing: { externalLinkSharing: ExternalSharingMode } } };
  }>('/api/workspace-policy', options);
  return data.managed ? data.policy.sharing.externalLinkSharing : 'allowed';
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
