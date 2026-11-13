import {
  cloudGet,
  cloudGetForAuthGeneration,
  cloudPost,
  cloudPostForAuthGeneration,
  cloudPatch,
  cloudPatchForAuthGeneration,
  cloudDelete,
  cloudDeleteForAuthGeneration,
} from "./cloudApi.js";

interface FolderInput {
  name: string;
  client_folder_id?: string;
  is_default?: boolean;
  sort_order?: number;
  private_workspace_id?: string | null;
  // Sets the placement only where the server has none (sent with the id and placement alone).
  placement_backfill?: true;
  workspace_id?: string | null;
  space_id?: string | null;
}

interface CloudFolder {
  id: string;
  client_folder_id: string | null;
  name: string;
  is_default: boolean;
  sort_order: number;
  private_workspace_id?: string | null;
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

async function create(folder: FolderInput, authGeneration?: number): Promise<CloudFolder> {
  return authGeneration === undefined
    ? cloudPost<CloudFolder>("/api/folders/create", folder)
    : cloudPostForAuthGeneration<CloudFolder>("/api/folders/create", folder, authGeneration);
}

// Per-row refusals are optional on older batch endpoints.
export interface RefusedFolder {
  client_folder_id: string | null;
  code: string;
}

async function batchCreate(
  folders: FolderInput[],
  authGeneration?: number
): Promise<{ created: CloudFolder[]; refused?: RefusedFolder[] }> {
  return authGeneration === undefined
    ? cloudPost<{ created: CloudFolder[]; refused?: RefusedFolder[] }>(
        "/api/folders/batch-create",
        { folders }
      )
    : cloudPostForAuthGeneration<{ created: CloudFolder[]; refused?: RefusedFolder[] }>(
        "/api/folders/batch-create",
        { folders },
        authGeneration
      );
}

async function update(
  id: string,
  updates: Partial<FolderInput>,
  authGeneration?: number
): Promise<CloudFolder> {
  return authGeneration === undefined
    ? cloudPatch<CloudFolder>("/api/folders/update", { id, ...updates })
    : cloudPatchForAuthGeneration<CloudFolder>(
        "/api/folders/update",
        { id, ...updates },
        authGeneration
      );
}

async function deleteFolder(id: string, authGeneration?: number): Promise<void> {
  if (authGeneration === undefined) await cloudDelete("/api/folders/delete", { id });
  else await cloudDeleteForAuthGeneration("/api/folders/delete", { id }, authGeneration);
}

// Given an auth generation, the request is pinned to that sign-in: refused
// once it is replaced, never sent with the next one's token.
async function list(
  since?: string,
  scope?: "all",
  authGeneration?: number,
  cache?: "no-store"
): Promise<{ folders: CloudFolder[] }> {
  const params = new URLSearchParams();
  if (since !== undefined) params.set("since", since);
  if (scope !== undefined) params.set("scope", scope);
  const query = params.toString();
  const path = `/api/folders/list${query ? `?${query}` : ""}`;
  return authGeneration === undefined
    ? cloudGet<{ folders: CloudFolder[] }>(path, cache)
    : cloudGetForAuthGeneration<{ folders: CloudFolder[] }>(path, authGeneration, cache);
}

export { create, batchCreate, update, deleteFolder, list };

export const FoldersService = {
  create,
  batchCreate,
  update,
  delete: deleteFolder,
  list,
};
