import { cloudGet, cloudGetPublic, cloudPost, cloudDelete, type DataWrap } from "./cloudApi.js";
import type { WorkspaceInvitation, InvitationPreview } from "../types/electron";

// email_sent is separate because the invite row is created even when the email fails.
type InvitationSendResult = WorkspaceInvitation & { email_sent: boolean };

async function list(workspaceId: string): Promise<WorkspaceInvitation[]> {
  const res = await cloudGet<DataWrap<WorkspaceInvitation[]>>(
    `/api/workspaces/${workspaceId}/invitations`
  );
  return res.data;
}

async function send(
  workspaceId: string,
  input: { email: string; role?: "admin" | "member"; team_ids?: string[] }
): Promise<InvitationSendResult> {
  const res = await cloudPost<DataWrap<InvitationSendResult>>(
    `/api/workspaces/${workspaceId}/invitations`,
    input
  );
  return res.data;
}

async function revoke(workspaceId: string, invitationId: string): Promise<void> {
  await cloudDelete(`/api/workspaces/${workspaceId}/invitations/${invitationId}`);
}

async function resend(workspaceId: string, invitationId: string): Promise<{ email_sent: boolean }> {
  const res = await cloudPost<DataWrap<{ resent: boolean; email_sent: boolean }>>(
    `/api/workspaces/${workspaceId}/invitations/${invitationId}`
  );
  return { email_sent: res.data.email_sent };
}

async function preview(token: string): Promise<InvitationPreview> {
  const res = await cloudGetPublic<DataWrap<InvitationPreview>>(
    `/api/invitations/${encodeURIComponent(token)}`
  );
  return res.data;
}

async function accept(token: string): Promise<{ workspace_id: string; role: string }> {
  const res = await cloudPost<DataWrap<{ workspace_id: string; role: string }>>(
    `/api/invitations/${encodeURIComponent(token)}/accept`
  );
  return res.data;
}

export const InvitationsService = {
  list,
  send,
  revoke,
  resend,
  preview,
  accept,
};
