import {
  cloudGet,
  cloudGetForAuthGeneration,
  cloudPost,
  cloudPatch,
  cloudDelete,
} from "./cloudApi.js";

interface FolderInput {
  name: string;
  client_folder_id?: string;
  is_default?: boolean;
  sort_order?: number;
  workspace_id?: string | null;
  space_id?: string | null;
}

interface CloudFolder {
  id: string;
  client_folder_id: string | null;
  name: string;
  is_default: boolean;
  sort_order: number;
  workspace_id: string | null;
  space_id: string | null;
  previous_space_id?: string | null;
  // Redacted stub for a row that moved out of one of the caller's spaces —
  // only id/client_folder_id/scope/updated_at are present.
  access_removed?: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

async function create(folder: FolderInput): Promise<CloudFolder> {
  return cloudPost<CloudFolder>("/api/folders/create", folder);
}

// Folders the server left out of a batch, with why: personal folders of an
// account that keeps private notes on its devices (personal_notes_on_device).
// Absent from APIs that predate it.
export interface RefusedFolder {
  client_folder_id: string | null;
  code: string;
}

async function batchCreate(
  folders: FolderInput[]
): Promise<{ created: CloudFolder[]; refused?: RefusedFolder[] }> {
  return cloudPost<{ created: CloudFolder[]; refused?: RefusedFolder[] }>(
    "/api/folders/batch-create",
    { folders }
  );
}

async function update(id: string, updates: Partial<FolderInput>): Promise<CloudFolder> {
  return cloudPatch<CloudFolder>("/api/folders/update", { id, ...updates });
}

async function deleteFolder(id: string): Promise<void> {
  await cloudDelete("/api/folders/delete", { id });
}

// Given an auth generation, the request is pinned to that sign-in: refused
// once it is replaced, never sent with the next one's token.
async function list(
  since?: string,
  scope?: "all",
  authGeneration?: number
): Promise<{ folders: CloudFolder[] }> {
  const params = new URLSearchParams();
  if (since !== undefined) params.set("since", since);
  if (scope !== undefined) params.set("scope", scope);
  const query = params.toString();
  const path = `/api/folders/list${query ? `?${query}` : ""}`;
  return authGeneration === undefined
    ? cloudGet<{ folders: CloudFolder[] }>(path)
    : cloudGetForAuthGeneration<{ folders: CloudFolder[] }>(path, authGeneration);
}

export { create, batchCreate, update, deleteFolder, list };

export const FoldersService = {
  create,
  batchCreate,
  update,
  delete: deleteFolder,
  list,
};
