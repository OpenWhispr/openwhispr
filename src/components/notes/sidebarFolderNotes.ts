import type { NoteItem } from "../../types/electron";
import { normalizeDbDate } from "../../utils/dateFormatting";

const SHOWN_NOTES = 5;

export function sidebarFolderNotes(
  notes: NoteItem[],
  activeNote: NoteItem | null,
  folderId: number,
  total: number
): { notes: NoteItem[]; hiddenCount: number } {
  // The store keeps an edited note in its old slot, so order by updated_at here.
  const visible = [...notes]
    .sort(
      (a, b) => normalizeDbDate(b.updated_at).getTime() - normalizeDbDate(a.updated_at).getTime()
    )
    .slice(0, SHOWN_NOTES);
  if (activeNote?.folder_id === folderId && !visible.some((note) => note.id === activeNote.id)) {
    visible.push(activeNote);
  }
  return { notes: visible, hiddenCount: total > SHOWN_NOTES ? total - visible.length : 0 };
}
