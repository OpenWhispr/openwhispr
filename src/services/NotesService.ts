import { OPENWHISPR_API_URL } from "../config/constants.js";

interface NoteInput {
  client_note_id?: string;
  title?: string | null;
  content?: string;
  enhanced_content?: string | null;
  enhancement_prompt?: string | null;
  note_type?: "personal" | "meeting" | "upload";
  source_file?: string | null;
  audio_duration_seconds?: number | null;
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
  created_at: string;
  updated_at: string;
}

interface SearchResult extends CloudNote {
  score: number;
}

async function create(note: NoteInput): Promise<CloudNote> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/notes/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(note),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CloudNote>;
}

async function batchCreate(
  notes: NoteInput[]
): Promise<{ created: { client_note_id: string; id: string }[] }> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/notes/batch-create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ notes }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ created: { client_note_id: string; id: string }[] }>;
}

async function update(id: string, updates: Partial<NoteInput>): Promise<CloudNote> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/notes/update`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ id, ...updates }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<CloudNote>;
}

async function deleteNote(id: string): Promise<void> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/notes/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ id }),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function list(limit?: number, before?: string): Promise<{ notes: CloudNote[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (before !== undefined) params.set("before", before);
  const query = params.toString();
  const res = await fetch(`${OPENWHISPR_API_URL}/api/notes/list${query ? `?${query}` : ""}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ notes: CloudNote[] }>;
}

async function deleteAll(): Promise<{ deleted: number; errors: number }> {
  // Try bulk endpoint first; fall back to per-note deletion
  try {
    const res = await fetch(`${OPENWHISPR_API_URL}/api/notes/delete-all`, {
      method: "DELETE",
      credentials: "include",
    });
    if (res.ok) {
      const data = (await res.json()) as { deleted?: number };
      return { deleted: data.deleted ?? 0, errors: 0 };
    }
  } catch {
    // bulk endpoint doesn't exist — fall through
  }

  // Fallback: list all and delete one-by-one
  const { notes } = await list(9999);
  const results = await Promise.allSettled(notes.map((n) => deleteNote(n.id)));
  const errors = results.filter((r) => r.status === "rejected").length;
  return { deleted: results.length - errors, errors };
}

async function search(query: string, limit?: number): Promise<{ notes: SearchResult[] }> {
  const res = await fetch(`${OPENWHISPR_API_URL}/api/notes/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ query, ...(limit !== undefined ? { limit } : {}) }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<{ notes: SearchResult[] }>;
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
