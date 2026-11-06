/**
 * a small cache of the user's notes for [[note links]]:
 * resolving a title to a note, the [[ picker, and backlinks. Reads through the
 * renderer's existing note IPC (signed-out and signed-in scopes alike).
 */
export interface IndexedNote {
  id: number;
  title: string;
  content: string;
  enhanced: string;
  updatedAt: string;
}

let notes: IndexedNote[] = [];
let loadedAt = 0;
let inflight: Promise<IndexedNote[]> | null = null;
const listeners = new Set<() => void>();

const api = () => (window as any).electronAPI;
const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

export function onNotesIndexChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Loads (or reuses, if under maxAgeMs old) the note list. */
export function loadNotes(maxAgeMs = 15000): Promise<IndexedNote[]> {
  if (Date.now() - loadedAt < maxAgeMs) return Promise.resolve(notes);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows: any[] = (await api()?.getNotes?.(null, 2000)) ?? [];
      notes = rows
        .filter((r) => r && r.id != null && !r.deleted_at)
        .map((r) => ({
          id: r.id,
          title: (r.title || "").trim(),
          content: r.content || "",
          enhanced: r.enhanced_content || "",
          updatedAt: r.updated_at || "",
        }));
      loadedAt = Date.now();
      listeners.forEach((l) => l());
    } catch {
      // keep the previous list
    } finally {
      inflight = null;
    }
    return notes;
  })();
  return inflight;
}

export function invalidateNotes() {
  loadedAt = 0;
}

/** The note a [[title]] points at: exact title match, case-insensitive, newest first. */
export function resolveTitle(title: string): IndexedNote | null {
  const key = norm(title);
  if (!key) return null;
  const matches = notes.filter((n) => norm(n.title) === key);
  matches.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return matches[0] ?? null;
}

/** Picker results: titles containing every word of the query, best first. */
export function searchTitles(query: string, limit = 8): IndexedNote[] {
  const words = norm(query).split(" ").filter(Boolean);
  const titled = notes.filter((n) => n.title);
  if (!words.length) {
    return [...titled].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
  }
  return titled
    .filter((n) => words.every((w) => norm(n.title).includes(w)))
    .sort((a, b) => {
      const q = norm(query);
      const rank = (n: IndexedNote) =>
        norm(n.title) === q ? 0 : norm(n.title).startsWith(q) ? 1 : 2;
      return rank(a) - rank(b) || (a.updatedAt < b.updatedAt ? 1 : -1);
    })
    .slice(0, limit);
}

/** Notes whose body or AI summary links to this title (either saved form). */
export function backlinksTo(title: string, selfId: number | null): IndexedNote[] {
  const key = norm(title);
  if (!key) return [];
  const pattern = /\\?\[\\?\[((?:\\.|[^\]\\\n])+?)\\?\]\\?\]/g;
  return notes.filter((n) => {
    if (n.id === selfId) return false;
    for (const text of [n.content, n.enhanced]) {
      for (const m of text.matchAll(pattern)) {
        if (norm(m[1].replace(/\\(.)/g, "$1")) === key) return true;
      }
    }
    return false;
  });
}

export function openNote(id: number) {
  void api()?.agentOpenNote?.(id);
}
