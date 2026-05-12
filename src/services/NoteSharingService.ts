import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";
import type {
  NoteShareInvitation,
  ShareSettings,
  ShareVisibility,
} from "../types/electron";

export interface ShareStateResponse {
  share: ShareSettings;
  invitations: NoteShareInvitation[];
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

async function getShareSettings(cloudNoteId: string): Promise<ShareStateResponse> {
  return cloudGet<ShareStateResponse>(sharePath(cloudNoteId));
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
  await cloudDelete(
    sharePath(cloudNoteId, `/invitations/${encodeURIComponent(invitationId)}`)
  );
}

async function resendInvite(
  cloudNoteId: string,
  invitationId: string
): Promise<{ id: string; resent: boolean }> {
  return cloudPost<{ id: string; resent: boolean }>(
    sharePath(cloudNoteId, `/invitations/${encodeURIComponent(invitationId)}/resend`)
  );
}

export const NoteSharingService = {
  getShareSettings,
  updateShareSettings,
  clearShare,
  rotateToken,
  inviteEmails,
  revokeInvite,
  resendInvite,
};
