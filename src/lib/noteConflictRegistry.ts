import type { CloudNote } from "../services/NotesService";

// Full cloud snapshots for unresolved conflicts. Persisting only client ids
// kept the push gate active after relaunch but left the editor with no payload
// to render or resolve.
const KEY = "noteConflicts.clientIds";

function readStoredConflicts(): Record<string, CloudNote> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // Pre-payload versions stored only ids. They cannot restore a banner, so
      // unblock them once: the guarded push will 409 again and persist the
      // server's current snapshot in the new format.
      localStorage.removeItem(KEY);
      return {};
    }
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value && typeof value === "object")
    ) as Record<string, CloudNote>;
  } catch {
    return {};
  }
}

export function readNoteConflicts(): Record<string, CloudNote> {
  return readStoredConflicts();
}

export function readNoteConflictIds(): Set<string> {
  return new Set(Object.keys(readStoredConflicts()));
}

export function addNoteConflict(clientNoteId: string, cloudNote: CloudNote): void {
  try {
    const conflicts = readStoredConflicts();
    conflicts[clientNoteId] = cloudNote;
    localStorage.setItem(KEY, JSON.stringify(conflicts));
  } catch {
    // The in-memory store still surfaces the conflict for this session.
  }
}

export function removeNoteConflictId(clientNoteId: string): void {
  try {
    const conflicts = readStoredConflicts();
    if (!(clientNoteId in conflicts)) return;
    delete conflicts[clientNoteId];
    localStorage.setItem(KEY, JSON.stringify(conflicts));
  } catch {
    // A failed persistence cleanup is harmless; the next guarded push can
    // surface the conflict again.
  }
}

export function clearNoteConflicts(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Account transitions still clear the in-memory copy.
  }
}
