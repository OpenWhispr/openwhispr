import { cloudGet, cloudPost, cloudDelete } from "./cloudApi.js";
import type { WorkspaceApiKey, NewWorkspaceApiKey } from "../types/electron";

interface DataWrap<T> {
  data: T;
}

async function list(workspaceId: string): Promise<WorkspaceApiKey[]> {
  const res = await cloudGet<DataWrap<WorkspaceApiKey[]>>(
    `/api/workspaces/${workspaceId}/api-keys`
  );
  return res.data;
}

async function create(
  workspaceId: string,
  input: { name: string; scopes: string[]; expires_in_days?: number; description?: string }
): Promise<NewWorkspaceApiKey> {
  const res = await cloudPost<DataWrap<NewWorkspaceApiKey>>(
    `/api/workspaces/${workspaceId}/api-keys`,
    input
  );
  return res.data;
}

async function revoke(workspaceId: string, keyId: string): Promise<void> {
  await cloudDelete(`/api/workspaces/${workspaceId}/api-keys/${keyId}`);
}

export const WorkspaceApiKeysService = {
  list,
  create,
  revoke,
};
