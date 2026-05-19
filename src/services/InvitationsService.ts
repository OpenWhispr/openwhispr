import { cloudGet, cloudPost, cloudDelete } from "./cloudApi.js";
import type { WorkspaceInvitation, InvitationPreview } from "../types/electron";

interface DataWrap<T> {
  data: T;
}

async function list(workspaceId: string): Promise<WorkspaceInvitation[]> {
  const res = await cloudGet<DataWrap<WorkspaceInvitation[]>>(
    `/api/workspaces/${workspaceId}/invitations`
  );
  return res.data;
}

async function send(
  workspaceId: string,
  input: { email: string; role?: "admin" | "member"; team_ids?: string[] }
): Promise<WorkspaceInvitation> {
  const res = await cloudPost<DataWrap<WorkspaceInvitation>>(
    `/api/workspaces/${workspaceId}/invitations`,
    input
  );
  return res.data;
}

async function revoke(workspaceId: string, invitationId: string): Promise<void> {
  await cloudDelete(`/api/workspaces/${workspaceId}/invitations/${invitationId}`);
}

async function resend(workspaceId: string, invitationId: string): Promise<void> {
  await cloudPost(`/api/workspaces/${workspaceId}/invitations/${invitationId}`);
}

async function preview(token: string): Promise<InvitationPreview> {
  const res = await cloudGet<DataWrap<InvitationPreview>>(
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
