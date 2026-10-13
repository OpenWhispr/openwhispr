import { api } from '@/lib/apiClient';

export type RemoteDictionarySource = 'manual' | 'learned';

export interface RemoteDictionaryEntry {
  id: string;
  client_dict_id: string | null;
  word: string;
  source: RemoteDictionarySource;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DictionaryPushInput {
  word: string;
  source: RemoteDictionarySource;
  client_dict_id: string;
  created_at?: string;
  updated_at?: string;
}

async function fetchList(
  keyset: 'since' | 'cursor',
  value: string | null,
  id: string | null,
  limit: number,
): Promise<{ entries: RemoteDictionaryEntry[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (value) params.set(keyset, value);
  if (id) params.set(`${keyset}_id`, id);
  if (limit) params.set('limit', String(limit));
  const q = params.toString();
  const res = await api.get<{ entries: RemoteDictionaryEntry[]; hasMore?: boolean }>(
    `/api/dictionary/list${q ? `?${q}` : ''}`,
  );
  return { entries: res.entries, hasMore: !!res.hasMore };
}

// Delta sync: rows where `updated_at >= since`, ordered by (updated_at, id),
// INCLUDES tombstones so the local pull can apply server-side deletes.
export function fetchDictionary(
  since: string | null,
  limit = 200,
  sinceId: string | null = null,
): Promise<{ entries: RemoteDictionaryEntry[]; hasMore: boolean }> {
  return fetchList('since', since, sinceId, limit);
}

// Snapshot pagination: walks the full live dictionary keyed on
// (created_at, id), EXCLUDES tombstones. Used by initial pull when no `since`
// boundary exists — using the delta endpoint there mid-streams two orderings
// (created_at on the first page, updated_at after) and can skip rows whose
// updated_at < the first page's max updated_at.
export function fetchDictionarySnapshot(
  cursor: string | null,
  limit = 200,
  cursorId: string | null = null,
): Promise<{ entries: RemoteDictionaryEntry[]; hasMore: boolean }> {
  return fetchList('cursor', cursor, cursorId, limit);
}

export async function batchCreateDictionary(
  items: DictionaryPushInput[],
): Promise<RemoteDictionaryEntry[]> {
  const res = await api.post<{ created: RemoteDictionaryEntry[] }>('/api/dictionary/batch-create', {
    entries: items,
  });
  return res.created;
}

export async function updateDictionaryEntry(
  remoteId: string,
  patch: { word?: string; source?: RemoteDictionarySource },
): Promise<RemoteDictionaryEntry> {
  return await api.patch<RemoteDictionaryEntry>('/api/dictionary/update', {
    id: remoteId,
    ...patch,
  });
}

export async function deleteDictionaryEntry(remoteId: string): Promise<void> {
  await api.delete('/api/dictionary/delete', { id: remoteId });
}
