import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";
import { buildNotesListPath } from "./noteListQuery";

interface NoteInput {
  client_note_id?: string;
  workspace_id?: string | null;
  space_id?: string | null;
  title?: string | null;
  content?: string;
  enhanced_content?: string | null;
  enhancement_prompt?: string | null;
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
}

export interface CloudNote {
  id: string;
  client_note_id: string | null;
  title: string | null;
  content: string;
  enhanced_content: string | null;
  note_type: string;
  enhancement_prompt: string | null;
  source_file: string | null;
  audio_duration_seconds: number | null;
  folder_id: string | null;
  transcript: string | null;
  enhanced_at_content_hash: string | null;
  participants: string | null;
  calendar_event_id: string | null;
  diarization_enabled: number | null;
  expected_speaker_count: number | null;
  workspace_id: string | null;
  space_id: string | null;
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

async function create(note: NoteInput): Promise<CloudNote> {
  return cloudPost<CloudNote>("/api/notes/create", note);
}

async function batchCreate(
  notes: NoteInput[]
): Promise<{ created: { client_note_id: string; id: string }[] }> {
  return cloudPost<{ created: { client_note_id: string; id: string }[] }>(
    "/api/notes/batch-create",
    { notes }
  );
}

async function update(id: string, updates: Partial<NoteInput>): Promise<CloudNote> {
  return cloudPatch<CloudNote>("/api/notes/update", { id, ...updates });
}

async function deleteNote(id: string): Promise<void> {
  await cloudDelete("/api/notes/delete", { id });
}

async function list(
  limit?: number,
  before?: string,
  since?: string,
  scope?: "all",
  cursorId?: string
): Promise<{ notes: CloudNote[] }> {
  return cloudGet<{ notes: CloudNote[] }>(
    buildNotesListPath({ limit, before, since, scope, cursorId })
  );
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
async function search(
  query: string,
  limit?: number,
  scope?: "all",
  spaceId?: string
): Promise<{ notes: SearchResult[] }> {
  return cloudPost<{ notes: SearchResult[] }>("/api/notes/search", {
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(spaceId !== undefined ? { space_id: spaceId } : {}),
  });
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
