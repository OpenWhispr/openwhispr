import type { ActionKind, ActionOutput, TemplateSection } from "../types/electron";
import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";

// Every write carries the whole row: an update replaces the cloud copy, so a
// field cleared locally is cleared there too.
export interface NoteActionFields {
  kind: ActionKind;
  name: string;
  description: string;
  prompt: string;
  sections: TemplateSection[] | null;
  output: ActionOutput | null;
  icon: string | null;
  sort_order: number;
}

interface NoteActionEntryInput extends NoteActionFields {
  client_action_id: string;
  created_at?: string;
}

export interface CloudNoteActionEntry extends NoteActionFields {
  id: string;
  client_action_id: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

async function batchCreate(
  entries: NoteActionEntryInput[]
): Promise<{ created: CloudNoteActionEntry[] }> {
  return cloudPost<{ created: CloudNoteActionEntry[] }>("/api/note-actions/batch-create", {
    entries,
  });
}

async function update(id: string, fields: NoteActionFields): Promise<CloudNoteActionEntry> {
  return cloudPatch<CloudNoteActionEntry>("/api/note-actions/update", { id, ...fields });
}

async function deleteEntry(id: string): Promise<void> {
  await cloudDelete("/api/note-actions/delete", { id });
}

async function listSnapshot(
  cursor?: string,
  limit?: number,
  cursorId?: string
): Promise<{ entries: CloudNoteActionEntry[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (cursorId) params.set("cursor_id", cursorId);
  if (limit) params.set("limit", String(limit));
  const query = params.toString() ? `?${params}` : "";
  return cloudGet<{ entries: CloudNoteActionEntry[]; hasMore: boolean }>(
    `/api/note-actions/list${query}`
  );
}

async function listDelta(
  since?: string,
  limit?: number,
  sinceId?: string
): Promise<{ entries: CloudNoteActionEntry[]; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (since) params.set("since", since);
  if (sinceId) params.set("since_id", sinceId);
  if (limit) params.set("limit", String(limit));
  const query = params.toString() ? `?${params}` : "";
  return cloudGet<{ entries: CloudNoteActionEntry[]; hasMore: boolean }>(
    `/api/note-actions/list${query}`
  );
}

export const NoteActionService = {
  batchCreate,
  update,
  delete: deleteEntry,
  listSnapshot,
  listDelta,
};
