import { CloudApiError, cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";
import type {
  NoteAccessGrant,
  NoteAccessPrincipal,
  NoteAccessState,
  NotePermission,
  NoteShareInvitation,
  ShareSettings,
  ShareVisibility,
} from "../types/electron";

export interface ShareStateResponse {
  share: ShareSettings;
  invitations: NoteShareInvitation[];
  // Optional so the desktop can roll out against the legacy sharing service.
  access?: NoteAccessState;
}

export interface ShareMutationResponse {
  share: ShareSettings;
  raw_token: string | null;
}

export interface RotateTokenResponse {
  share: ShareSettings;
  raw_token: string;
}

export interface CreateInvitationsResponse {
  created: NoteShareInvitation[];
  already_invited: string[];
  email_failed_ids: string[];
}

function sharePath(cloudId: string, suffix: string = ""): string {
  return `/api/notes/${encodeURIComponent(cloudId)}/share${suffix}`;
}

function accessPath(cloudId: string, suffix: string = ""): string {
  return `/api/notes/${encodeURIComponent(cloudId)}/access${suffix}`;
}

async function getShareSettings(cloudNoteId: string): Promise<ShareStateResponse> {
  const state = await cloudGet<ShareStateResponse>(sharePath(cloudNoteId));
  if (state.access) return state;

  // The ACL API is deployed independently from legacy link sharing. A 404 is
  // the expected compatibility response until that rollout reaches a server.
  try {
    return { ...state, access: await getAccessSettings(cloudNoteId) };
  } catch (error) {
    if (error instanceof CloudApiError && (error.status === 404 || error.code === "not_found")) {
      return state;
    }
    throw error;
  }
}

async function updateShareSettings(
  cloudNoteId: string,
  visibility: ShareVisibility,
  domainAllowlist: string[]
): Promise<ShareMutationResponse> {
  return cloudPatch<ShareMutationResponse>(sharePath(cloudNoteId), {
    visibility,
    domain_allowlist: domainAllowlist,
  });
}

async function clearShare(cloudNoteId: string): Promise<{ share: ShareSettings }> {
  return cloudDelete<{ share: ShareSettings }>(sharePath(cloudNoteId));
}

async function rotateToken(cloudNoteId: string): Promise<RotateTokenResponse> {
  return cloudPost<RotateTokenResponse>(sharePath(cloudNoteId, "/rotate-token"));
}

async function inviteEmails(
  cloudNoteId: string,
  emails: string[]
): Promise<CreateInvitationsResponse> {
  return cloudPost<CreateInvitationsResponse>(sharePath(cloudNoteId, "/invitations"), {
    emails,
  });
}

async function revokeInvite(cloudNoteId: string, invitationId: string): Promise<void> {
  await cloudDelete(sharePath(cloudNoteId, `/invitations/${encodeURIComponent(invitationId)}`));
}

async function resendInvite(
  cloudNoteId: string,
  invitationId: string
): Promise<{ id: string; resent: boolean }> {
  return cloudPost<{ id: string; resent: boolean }>(
    sharePath(cloudNoteId, `/invitations/${encodeURIComponent(invitationId)}/resend`)
  );
}

export interface AccessPrincipalSuggestion extends NoteAccessPrincipal {
  existing_grant_id: string | null;
}

async function getAccessSettings(cloudNoteId: string): Promise<NoteAccessState> {
  return cloudGet<NoteAccessState>(accessPath(cloudNoteId));
}

async function searchAccessPrincipals(
  cloudNoteId: string,
  query: string
): Promise<{ suggestions: AccessPrincipalSuggestion[] }> {
  const suffix = `/suggestions?q=${encodeURIComponent(query)}`;
  return cloudGet<{ suggestions: AccessPrincipalSuggestion[] }>(accessPath(cloudNoteId, suffix));
}

async function createAccessGrant(
  cloudNoteId: string,
  input: {
    principal_type: NoteAccessPrincipal["type"];
    principal_id?: string;
    email?: string;
    permission: Exclude<NotePermission, "owner">;
  }
): Promise<NoteAccessGrant> {
  return cloudPost<NoteAccessGrant>(accessPath(cloudNoteId, "/grants"), input);
}

async function updateAccessGrant(
  cloudNoteId: string,
  grantId: string,
  permission: Exclude<NotePermission, "owner">
): Promise<NoteAccessGrant> {
  return cloudPatch<NoteAccessGrant>(
    accessPath(cloudNoteId, `/grants/${encodeURIComponent(grantId)}`),
    { permission }
  );
}

async function removeAccessGrant(cloudNoteId: string, grantId: string): Promise<void> {
  await cloudDelete(accessPath(cloudNoteId, `/grants/${encodeURIComponent(grantId)}`));
}

export const NoteSharingService = {
  getShareSettings,
  updateShareSettings,
  clearShare,
  rotateToken,
  inviteEmails,
  revokeInvite,
  resendInvite,
  getAccessSettings,
  searchAccessPrincipals,
  createAccessGrant,
  updateAccessGrant,
  removeAccessGrant,
};
