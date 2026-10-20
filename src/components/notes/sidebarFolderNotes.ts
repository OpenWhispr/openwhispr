import type { NoteItem } from "../../types/electron";

export function sidebarFolderNotes(
  notes: NoteItem[],
  activeNote: NoteItem | null,
  folderId: number
): NoteItem[] {
  const visible = notes.slice(0, 5);
  if (activeNote?.folder_id === folderId && !visible.some((note) => note.id === activeNote.id)) {
    visible.push(activeNote);
  }
  return visible;
}
