import { api } from '@/lib/apiClient';

export interface RemoteSharedEntry {
  id: string;
  workspace_id: string;
  space_id: string | null;
  word: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface RemoteSharedScope {
  space_id: string | null;
  name: string;
  member_count: number;
  word_count: number;
}

export interface RemoteSharedHide {
  entry_id: string;
  workspace_id: string;
  updated_at: string;
  deleted_at: string | null;
}

// `since`/`sinceId` walk the delta keyset (updated_at); `cursor`/`cursorId`
// walk the snapshot keyset (created_at). Callers pass one pair, never both.
export interface SharedDictionaryPage {
  since?: string;
  sinceId?: string;
  cursor?: string;
  cursorId?: string;
  limit?: number;
}

function pageQuery(workspaceId: string, page: SharedDictionaryPage): string {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  if (page.since) params.set('since', page.since);
  if (page.sinceId) params.set('since_id', page.sinceId);
  if (page.cursor) params.set('cursor', page.cursor);
  if (page.cursorId) params.set('cursor_id', page.cursorId);
  if (page.limit) params.set('limit', String(page.limit));
  return params.toString();
}

export async function fetchSharedDictionary(
  workspaceId: string,
  page: SharedDictionaryPage,
): Promise<{
  entries: RemoteSharedEntry[];
  hasMore: boolean;
  scopes: RemoteSharedScope[];
  paused: boolean;
  server_time: string;
}> {
  const res = await api.get<{
    entries: RemoteSharedEntry[];
    hasMore?: boolean;
    scopes?: RemoteSharedScope[];
    paused?: boolean;
    server_time: string;
  }>(`/api/shared-dictionary/list?${pageQuery(workspaceId, page)}`);
  return {
    entries: res.entries,
    hasMore: !!res.hasMore,
    scopes: res.scopes ?? [],
    paused: !!res.paused,
    server_time: res.server_time,
  };
}

export async function fetchSharedDictionaryHides(
  workspaceId: string,
  page: SharedDictionaryPage,
): Promise<{ hides: RemoteSharedHide[]; hasMore: boolean; server_time: string }> {
  const res = await api.get<{
    hides: RemoteSharedHide[];
    hasMore?: boolean;
    server_time: string;
  }>(`/api/shared-dictionary/hides?${pageQuery(workspaceId, page)}`);
  return { hides: res.hides, hasMore: !!res.hasMore, server_time: res.server_time };
}
