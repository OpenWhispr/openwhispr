import {
  cloudGet,
  cloudGetPublic,
  cloudPost,
  cloudPostForAuthGeneration,
  cloudDelete,
  type DataWrap,
} from "./cloudApi.js";
import type {
  InvitationBatchResult,
  InvitationPreview,
  WorkspaceInvitation,
} from "../types/electron";

async function list(workspaceId: string): Promise<WorkspaceInvitation[]> {
  const res = await cloudGet<DataWrap<WorkspaceInvitation[]>>(
    `/api/workspaces/${workspaceId}/invitations`
  );
  return res.data;
}

async function sendBatch(
  workspaceId: string,
  input: { emails: string[]; role: "admin" | "member"; team_ids?: string[]; space_ids?: string[] },
  authGeneration?: number
): Promise<InvitationBatchResult> {
  const path = `/api/workspaces/${workspaceId}/invitations/batch`;
  const res =
    authGeneration === undefined
      ? await cloudPost<DataWrap<InvitationBatchResult>>(path, input)
      : await cloudPostForAuthGeneration<DataWrap<InvitationBatchResult>>(
          path,
          input,
          authGeneration
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

// team_ids and space_ids are the authoritative post-accept grants (the
// invitation may have been edited since it was previewed); optional only
// because older API responses predate them.
type InvitationAcceptResult = {
  workspace_id: string;
  role: string;
  team_ids?: string[];
  space_ids?: string[];
};

async function accept(token: string): Promise<InvitationAcceptResult> {
  const res = await cloudPost<DataWrap<InvitationAcceptResult>>(
    `/api/invitations/${encodeURIComponent(token)}/accept`
  );
  return res.data;
}

export const InvitationsService = {
  list,
  sendBatch,
  revoke,
  resend,
  preview,
  accept,
};
