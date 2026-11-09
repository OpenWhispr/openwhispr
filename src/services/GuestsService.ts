import { cloudGet, cloudPost, type DataWrap } from "./cloudApi.js";
import type { GuestRemoval, WorkspaceGuest } from "../types/electron";

async function list(workspaceId: string): Promise<WorkspaceGuest[]> {
  const res = await cloudGet<DataWrap<WorkspaceGuest[]>>(`/api/workspaces/${workspaceId}/guests`);
  return res.data;
}

async function remove(
  workspaceId: string,
  input: { emails: string[]; note_id?: string }
): Promise<GuestRemoval> {
  const res = await cloudPost<DataWrap<GuestRemoval>>(
    `/api/workspaces/${workspaceId}/guests/remove`,
    input
  );
  return res.data;
}

export const GuestsService = { list, remove };
