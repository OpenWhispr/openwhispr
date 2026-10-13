import { api } from '@/lib/apiClient';
import type { RemoteFolder, RemoteNote, RemoteNoteCreateResult } from '../types';

// Folders

/**
 * `scope: 'all'` additionally returns folders in the caller's spaces and
 * folders whose `previous_space_id` is one of them. Omit it for the personal
 * pass, which only ever wants `space_id IS NULL` rows.
 */
export async function fetchFolders(since: string | null, scope?: 'all'): Promise<RemoteFolder[]> {
  const params: string[] = [];
  if (since) params.push(`since=${encodeURIComponent(since)}`);
  if (scope) params.push(`scope=${scope}`);
  const q = params.length > 0 ? `?${params.join('&')}` : '';
  const res = await api.get<{ folders: RemoteFolder[] }>(`/api/folders/list${q}`);
  return res.folders;
}

export interface FolderPushInput {
  name: string;
  client_folder_id: string;
  is_default?: boolean;
  sort_order?: number;
  // Scope fields, populated by pushScope.ts. Both are omitted entirely when the
  // backend predates team spaces; explicit nulls mean "personal", and omitting
  // space_id leaves whatever scope the server already stored.
  workspace_id?: string | null;
  space_id?: string | null;
}

export async function batchCreateFolders(items: FolderPushInput[]): Promise<RemoteFolder[]> {
  const res = await api.post<{ created: RemoteFolder[] }>('/api/folders/batch-create', {
    folders: items,
  });
  return res.created;
}

/**
 * Deliberately carries no scope fields, unlike FolderPushInput. Folders have no
 * `base_updated_at` to make a scope claim conditional, and mobile has no
 * folder-move feature — so a rename that also asserted scope could only ever
 * reverse a move made elsewhere. Omitting the keys leaves the stored scope
 * untouched (see pushFolders.ts).
 */
export interface FolderUpdateInput {
  name?: string;
  sort_order?: number;
}

export async function updateFolder(
  remoteId: string,
  patch: FolderUpdateInput,
): Promise<RemoteFolder> {
  return await api.patch<RemoteFolder>('/api/folders/update', { id: remoteId, ...patch });
}

export async function deleteFolder(remoteId: string): Promise<void> {
  await api.delete('/api/folders/delete', { id: remoteId });
}

// Notes

export interface FetchNotesParams {
  since?: string | null;
  /** Composite cursor with `since` — resumes exactly after (since, sinceId). */
  sinceId?: string;
  limit?: number;
  before?: string;
  /**
   * `'all'` additionally returns notes in the caller's spaces, notes whose
   * `previous_space_id` is one of them, and access-removed stubs. Omit it for
   * the personal pass.
   */
  scope?: 'all';
}

export async function fetchNotes(params: FetchNotesParams): Promise<{
  notes: RemoteNote[];
  /** Only returned by the API for composite-cursor requests. */
  hasMore?: boolean;
}> {
  const search = new URLSearchParams();
  if (params.since) search.set('since', params.since);
  if (params.sinceId) search.set('since_id', params.sinceId);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.before) search.set('before', params.before);
  if (params.scope) search.set('scope', params.scope);
  const q = search.toString();
  const res = await api.get<{ notes: RemoteNote[]; hasMore?: boolean }>(
    `/api/notes/list${q ? `?${q}` : ''}`,
  );
  return { notes: res.notes, hasMore: res.hasMore };
}

export interface NotePushInput {
  client_note_id: string;
  title: string | null;
  content: string;
  enhanced_content?: string | null;
  enhancement_prompt?: string | null;
  note_type?: string;
  source_file?: string | null;
  audio_duration_seconds?: number | null;
  folder_id?: string | null;
  participants?: string | null;
  calendar_event_id?: string | null;
  // Desktop-shape transcript JSON. Only sent when mobile is authoritative for the
  // transcript (see pushNotes); omitted so the server's COALESCE keeps the richer copy.
  transcript?: string | null;
  created_at?: string;
  updated_at?: string;
  // Scope fields, populated by pushScope.ts. Both are omitted entirely when the
  // backend predates team spaces; explicit nulls mean "personal", and omitting
  // space_id leaves whatever scope the server already stored.
  workspace_id?: string | null;
  space_id?: string | null;
  /** Echoes notes.cloud_updated_at so the server can 409 a stale overwrite. */
  base_updated_at?: string;
}

export async function batchCreateNotes(items: NotePushInput[]): Promise<RemoteNoteCreateResult[]> {
  const res = await api.post<{ created: RemoteNoteCreateResult[] }>('/api/notes/batch-create', {
    notes: items,
  });
  return res.created;
}

export async function updateNote(
  remoteId: string,
  patch: Omit<NotePushInput, 'client_note_id'>,
): Promise<RemoteNote> {
  return await api.patch<RemoteNote>('/api/notes/update', { id: remoteId, ...patch });
}

export async function deleteNote(remoteId: string): Promise<void> {
  await api.delete('/api/notes/delete', { id: remoteId });
}
