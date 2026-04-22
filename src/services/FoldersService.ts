import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";

interface FolderInput {
  name: string;
  client_folder_id?: string;
  is_default?: boolean;
  sort_order?: number;
}

interface CloudFolder {
  id: string;
  client_folder_id: string | null;
  name: string;
  is_default: boolean;
  sort_order: number;
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

async function list(since?: string): Promise<{ folders: CloudFolder[] }> {
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  return cloudGet<{ folders: CloudFolder[] }>(`/api/folders/list${query}`);
}

export { create, batchCreate, update, deleteFolder, list };

export const FoldersService = {
  create,
  batchCreate,
  update,
  delete: deleteFolder,
  list,
};
