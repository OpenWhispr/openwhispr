import {
  cloudGet,
  cloudGetForAuthGeneration,
  cloudPost,
  cloudPostForAuthGeneration,
  cloudPatch,
  cloudPatchForAuthGeneration,
  cloudDelete,
  cloudDeleteForAuthGeneration,
} from "./cloudApi.js";
import { buildNotesListPath } from "./noteListQuery";
import type { CloudNoteCreateResult } from "./noteCreateAck";

interface NoteInput {
  client_note_id?: string;
  private_workspace_id?: string | null;
  // Sets the placement only where the server has none (sent with the id and placement alone).
  placement_backfill?: true;
  workspace_id?: string | null;
  space_id?: string | null;
  title?: string | null;
  content?: string;
  enhanced_content?: string | null;
  enhancement_prompt?: string | null;
  enhancement_template_id?: string | null;
  note_type?: "personal" | "meeting" | "upload";
  source_file?: string | null;
  audio_duration_seconds?: number | null;
  participants?: string | null;
  calendar_event_id?: string | null;
  diarization_enabled?: number | null;
  expected_speaker_count?: number | null;
  transcript?: string | null;
  enhanced_at_content_hash?: string | null;
  folder_id?: string | null;
  created_at?: string;
  updated_at?: string;
  // Optimistic-concurrency base on updates: the server updated_at this device
  // last acked. The server 409s (note_version_conflict) when a newer write
  // landed; omitted = legacy last-write-wins.
  base_updated_at?: string;
  base_revision?: number;
  field_updates?: { content?: "set" | "clear"; enhanced_content?: "set" | "clear" };
}

export interface CloudNote {
  revision?: number;
  content_state?: "set" | "clear" | null;
  enhanced_content_state?: "set" | "clear" | null;
  write_applied?: boolean;
  row_created?: boolean;
  id: string;
  client_note_id: string | null;
  title: string | null;
  content: string;
  enhanced_content: string | null;
  note_type: string;
  enhancement_prompt: string | null;
  // Absent from APIs that predate note templates.
  enhancement_template_id?: string | null;
  source_file: string | null;
  audio_duration_seconds: number | null;
  folder_id: string | null;
  transcript: string | null;
  enhanced_at_content_hash: string | null;
  participants: string | null;
  calendar_event_id: string | null;
  diarization_enabled: number | null;
  expected_speaker_count: number | null;
  private_workspace_id?: string | null;
  workspace_id: string | null;
  space_id: string | null;
  // The note's owner (creator), not its last editor. Absent on access_removed
  // stubs and on API versions that predate ownership.
  user_id?: string | null;
  // Creator attribution is separate from the operational custodian. It is
  // explicitly null after the creator deletes their account.
  created_by_user_id?: string | null;
  updated_by_user_id: string | null;
  previous_space_id?: string | null;
  // Redacted stub for a row that moved out of one of the caller's spaces —
  // only id/client_note_id/scope/updated_at are present.
  access_removed?: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SearchResult extends CloudNote {
  score: number;
}

async function create(note: NoteInput, authGeneration?: number): Promise<CloudNote> {
  return authGeneration === undefined
    ? cloudPost<CloudNote>("/api/notes/create", note)
    : cloudPostForAuthGeneration<CloudNote>("/api/notes/create", note, authGeneration);
}

// Per-row refusals are optional on older batch endpoints.
export interface RefusedNote {
  client_note_id: string | null;
  code: string;
}

interface NoteBatchCreateResult {
  created: CloudNoteCreateResult[];
  refused?: RefusedNote[];
}

async function batchCreate(
  notes: NoteInput[],
  authGeneration?: number
): Promise<NoteBatchCreateResult> {
  return authGeneration === undefined
    ? cloudPost<NoteBatchCreateResult>("/api/notes/batch-create", { notes })
    : cloudPostForAuthGeneration<NoteBatchCreateResult>(
        "/api/notes/batch-create",
        { notes },
        authGeneration
      );
}

async function update(
  id: string,
  updates: Partial<NoteInput>,
  authGeneration?: number
): Promise<CloudNote> {
  return authGeneration === undefined
    ? cloudPatch<CloudNote>("/api/notes/update", { id, ...updates })
    : cloudPatchForAuthGeneration<CloudNote>(
        "/api/notes/update",
        { id, ...updates },
        authGeneration
      );
}

async function deleteNote(id: string, authGeneration?: number): Promise<void> {
  if (authGeneration === undefined) await cloudDelete("/api/notes/delete", { id });
  else await cloudDeleteForAuthGeneration("/api/notes/delete", { id }, authGeneration);
}

// Given an auth generation, the request is pinned to that sign-in: refused
// once it is replaced, never sent with the next one's token.
async function list(
  limit?: number,
  before?: string,
  since?: string,
  scope?: "all",
  cursorId?: string,
  authGeneration?: number,
  cache?: "no-store"
): Promise<{ notes: CloudNote[] }> {
  const path = buildNotesListPath({ limit, before, since, scope, cursorId });
  return authGeneration === undefined
    ? cloudGet<{ notes: CloudNote[] }>(path, cache)
    : cloudGetForAuthGeneration<{ notes: CloudNote[] }>(path, authGeneration, cache);
}

async function deleteAll(): Promise<{ deleted: number; errors: number }> {
  try {
    const data = await cloudDelete<{ deleted?: number }>("/api/notes/delete-all");
    return { deleted: data?.deleted ?? 0, errors: 0 };
  } catch {
    // bulk endpoint doesn't exist — fall through
  }

  const { notes } = await list(9999);
  const results = await Promise.allSettled(notes.map((n) => deleteNote(n.id)));
  const errors = results.filter((r) => r.status === "rejected").length;
  return { deleted: results.length - errors, errors };
}

// scope "all" opts into space results (legacy clients stay personal-only);
// space_id narrows to a single space and takes precedence over scope.
export interface NoteSearchScope {
  spaceIds: string[];
  privateWorkspaceId: string | null;
}

async function search(
  query: string,
  limit?: number,
  scope?: "all",
  spaceId?: string,
  authGeneration?: number,
  noteScope?: NoteSearchScope
): Promise<{ notes: SearchResult[] }> {
  const body = {
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(spaceId !== undefined ? { space_id: spaceId } : {}),
    ...(noteScope !== undefined
      ? { space_ids: noteScope.spaceIds, private_workspace_id: noteScope.privateWorkspaceId }
      : {}),
  };
  return authGeneration === undefined
    ? cloudPost<{ notes: SearchResult[] }>("/api/notes/search", body)
    : cloudPostForAuthGeneration<{ notes: SearchResult[] }>(
        "/api/notes/search",
        body,
        authGeneration
      );
}

export { create, batchCreate, update, deleteNote, deleteAll, list, search };

export const NotesService = {
  create,
  batchCreate,
  update,
  delete: deleteNote,
  deleteAll,
  list,
  search,
};
