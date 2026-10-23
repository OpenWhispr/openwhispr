import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";

export type DictionarySource = "manual" | "learned";

interface DictionaryEntryInput {
  word: string;
  source?: DictionarySource;
  client_dict_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface CloudDictionaryEntry {
  id: string;
  client_dict_id: string | null;
  word: string;
  source: DictionarySource;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

async function batchCreate(
  entries: DictionaryEntryInput[],
  authGeneration?: number
): Promise<{ created: CloudDictionaryEntry[] }> {
  return cloudPost<{ created: CloudDictionaryEntry[] }>(
    "/api/dictionary/batch-create",
    { entries },
    authGeneration
  );
}

async function update(
  id: string,
  updates: { word?: string; source?: DictionarySource },
  authGeneration?: number
): Promise<CloudDictionaryEntry> {
  return cloudPatch<CloudDictionaryEntry>(
    "/api/dictionary/update",
    { id, ...updates },
    authGeneration
  );
}

async function deleteEntry(id: string, authGeneration?: number): Promise<void> {
  await cloudDelete("/api/dictionary/delete", { id }, authGeneration);
}

async function listSnapshot(
  cursor?: string,
  limit?: number,
  cursorId?: string
): Promise<{ entries: CloudDictionaryEntry[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (cursorId) params.set("cursor_id", cursorId);
  if (limit) params.set("limit", String(limit));
  const query = params.toString() ? `?${params}` : "";
  return cloudGet<{ entries: CloudDictionaryEntry[]; hasMore: boolean }>(
    `/api/dictionary/list${query}`
  );
}

async function listDelta(
  since?: string,
  limit?: number,
  sinceId?: string
): Promise<{ entries: CloudDictionaryEntry[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (sinceId) params.set("since_id", sinceId);
  if (limit) params.set("limit", String(limit));
  const query = params.toString() ? `?${params}` : "";
  return cloudGet<{ entries: CloudDictionaryEntry[]; hasMore: boolean }>(
    `/api/dictionary/list${query}`
  );
}

export const DictionaryService = {
  batchCreate,
  update,
  delete: deleteEntry,
  listSnapshot,
  listDelta,
};
