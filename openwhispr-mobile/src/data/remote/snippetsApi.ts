import { api } from '@/lib/apiClient';

export interface RemoteSnippet {
  id: string;
  client_snippet_id: string | null;
  trigger: string;
  replacement: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SnippetPushInput {
  trigger: string;
  replacement: string;
  client_snippet_id: string;
  created_at?: string;
  updated_at?: string;
}

async function fetchList(
  keyset: 'since' | 'cursor',
  value: string | null,
  id: string | null,
  limit: number,
): Promise<{ entries: RemoteSnippet[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (value) params.set(keyset, value);
  if (id) params.set(`${keyset}_id`, id);
  if (limit) params.set('limit', String(limit));
  const q = params.toString();
  const res = await api.get<{ entries: RemoteSnippet[]; hasMore?: boolean }>(
    `/api/snippets/list${q ? `?${q}` : ''}`,
  );
  return { entries: res.entries, hasMore: !!res.hasMore };
}

// Delta sync: rows where `updated_at >= since`, ordered by (updated_at, id),
// INCLUDES tombstones so the local pull can apply server-side deletes.
export function fetchSnippets(
  since: string | null,
  limit = 200,
  sinceId: string | null = null,
): Promise<{ entries: RemoteSnippet[]; hasMore: boolean }> {
  return fetchList('since', since, sinceId, limit);
}

// Snapshot pagination: walks the full live snippet list keyed on (created_at, id),
// EXCLUDES tombstones. Used by the initial pull when no `since` boundary exists.
export function fetchSnippetsSnapshot(
  cursor: string | null,
  limit = 200,
  cursorId: string | null = null,
): Promise<{ entries: RemoteSnippet[]; hasMore: boolean }> {
  return fetchList('cursor', cursor, cursorId, limit);
}

export async function batchCreateSnippets(items: SnippetPushInput[]): Promise<RemoteSnippet[]> {
  const res = await api.post<{ created: RemoteSnippet[] }>('/api/snippets/batch-create', {
    entries: items,
  });
  return res.created;
}

export async function updateSnippet(
  remoteId: string,
  patch: { trigger?: string; replacement?: string },
): Promise<RemoteSnippet> {
  return await api.patch<RemoteSnippet>('/api/snippets/update', {
    id: remoteId,
    ...patch,
  });
}

export async function deleteSnippet(remoteId: string): Promise<void> {
  await api.delete('/api/snippets/delete', { id: remoteId });
}
