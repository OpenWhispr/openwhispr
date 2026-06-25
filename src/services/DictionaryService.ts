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
  entries: DictionaryEntryInput[]
): Promise<{ created: CloudDictionaryEntry[] }> {
  return cloudPost<{ created: CloudDictionaryEntry[] }>("/api/dictionary/batch-create", {
    entries,
  });
}

async function update(
  id: string,
  updates: { word?: string; source?: DictionarySource }
): Promise<CloudDictionaryEntry> {
  return cloudPatch<CloudDictionaryEntry>("/api/dictionary/update", { id, ...updates });
}

async function deleteEntry(id: string): Promise<void> {
  await cloudDelete("/api/dictionary/delete", { id });
}

async function list(
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
  list,
};
