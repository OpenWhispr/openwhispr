// Client ids of notes with an unresolved pull conflict, persisted so the push
// engine keeps honoring a conflict across restarts and windows (the banner's
// CloudNote payload stays in-memory; the first pull after launch re-surfaces
// it). Written only via the noteStore conflict setters.
const KEY = "noteConflicts.clientIds";

export function readNoteConflictIds(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function addNoteConflictId(clientNoteId: string): void {
  const ids = readNoteConflictIds();
  if (ids.has(clientNoteId)) return;
  ids.add(clientNoteId);
  localStorage.setItem(KEY, JSON.stringify([...ids]));
}

export function removeNoteConflictId(clientNoteId: string): void {
  const ids = readNoteConflictIds();
  if (!ids.delete(clientNoteId)) return;
  localStorage.setItem(KEY, JSON.stringify([...ids]));
}
