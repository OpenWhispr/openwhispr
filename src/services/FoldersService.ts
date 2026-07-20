import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";

interface FolderInput {
  name: string;
  client_folder_id?: string;
  is_default?: boolean;
  sort_order?: number;
  workspace_id?: string | null;
  team_id?: string | null;
}

interface CloudFolder {
  id: string;
  client_folder_id: string | null;
  name: string;
  is_default: boolean;
  sort_order: number;
  workspace_id: string | null;
  team_id: string | null;
  previous_team_id?: string | null;
  // Redacted stub for a row that moved out of one of the caller's teams —
  // only id/client_folder_id/scope/updated_at are present.
  access_removed?: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

async function create(folder: FolderInput): Promise<CloudFolder> {
  return cloudPost<CloudFolder>("/api/folders/create", folder);
}

async function batchCreate(folders: FolderInput[]): Promise<{ created: CloudFolder[] }> {
  return cloudPost<{ created: CloudFolder[] }>("/api/folders/batch-create", { folders });
}

async function update(id: string, updates: Partial<FolderInput>): Promise<CloudFolder> {
  return cloudPatch<CloudFolder>("/api/folders/update", { id, ...updates });
}

async function deleteFolder(id: string): Promise<void> {
  await cloudDelete("/api/folders/delete", { id });
}

async function list(since?: string, scope?: "all"): Promise<{ folders: CloudFolder[] }> {
  const params = new URLSearchParams();
  if (since !== undefined) params.set("since", since);
  if (scope !== undefined) params.set("scope", scope);
  const query = params.toString();
  return cloudGet<{ folders: CloudFolder[] }>(`/api/folders/list${query ? `?${query}` : ""}`);
}

export { create, batchCreate, update, deleteFolder, list };

export const FoldersService = {
  create,
  batchCreate,
  update,
  delete: deleteFolder,
  list,
};
