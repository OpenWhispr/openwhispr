import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";

interface SnippetEntryInput {
  trigger: string;
  replacement: string;
  client_snippet_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface CloudSnippetEntry {
  id: string;
  client_snippet_id: string | null;
  trigger: string;
  replacement: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

async function batchCreate(
  entries: SnippetEntryInput[]
): Promise<{ created: CloudSnippetEntry[] }> {
  return cloudPost<{ created: CloudSnippetEntry[] }>("/api/snippets/batch-create", {
    entries,
  });
}

async function update(
  id: string,
  updates: { trigger?: string; replacement?: string }
): Promise<CloudSnippetEntry> {
  return cloudPatch<CloudSnippetEntry>("/api/snippets/update", { id, ...updates });
}

async function deleteEntry(id: string): Promise<void> {
  await cloudDelete("/api/snippets/delete", { id });
}

async function listSnapshot(
  cursor?: string,
  limit?: number,
  cursorId?: string
): Promise<{ entries: CloudSnippetEntry[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (cursorId) params.set("cursor_id", cursorId);
  if (limit) params.set("limit", String(limit));
  const query = params.toString() ? `?${params}` : "";
  return cloudGet<{ entries: CloudSnippetEntry[]; hasMore: boolean }>(`/api/snippets/list${query}`);
}

async function listDelta(
  since?: string,
  limit?: number,
  sinceId?: string
): Promise<{ entries: CloudSnippetEntry[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (sinceId) params.set("since_id", sinceId);
  if (limit) params.set("limit", String(limit));
  const query = params.toString() ? `?${params}` : "";
  return cloudGet<{ entries: CloudSnippetEntry[]; hasMore: boolean }>(`/api/snippets/list${query}`);
}

export const SnippetService = {
  batchCreate,
  update,
  delete: deleteEntry,
  listSnapshot,
  listDelta,
};
