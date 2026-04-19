import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";

interface NoteInput {
  client_note_id?: string;
  title?: string | null;
  content?: string;
  enhanced_content?: string | null;
  enhancement_prompt?: string | null;
  note_type?: "personal" | "meeting" | "upload";
  source_file?: string | null;
  audio_duration_seconds?: number | null;
  participants?: string | null;
  transcript?: string | null;
  enhanced_at_content_hash?: string | null;
  folder_id?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface CloudNote {
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

async function list(limit?: number, before?: string): Promise<{ notes: CloudNote[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (before !== undefined) params.set("before", before);
  const query = params.toString();
  return cloudGet<{ notes: CloudNote[] }>(`/api/notes/list${query ? `?${query}` : ""}`);
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

async function search(query: string, limit?: number): Promise<{ notes: SearchResult[] }> {
  return cloudPost<{ notes: SearchResult[] }>("/api/notes/search", {
    query,
    ...(limit !== undefined ? { limit } : {}),
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
