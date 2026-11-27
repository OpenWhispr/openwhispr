import type { NoteItem, NoteWriteGuard } from "../../types/electron";

/** What the note tools may reach in one assistant turn. */
export interface NoteScope {
  /** The active workspace's Private and its teamspaces in scope (resolveAssistantScopeSpaceIds). */
  spaceIds: readonly number[];
  /** Persists conversation privacy before local content reaches tools or the model. */
  protectNotes?: (
    notes: ReadonlyArray<Pick<NoteItem, "id" | "space_id">>,
    deviceOnly?: boolean
  ) => Promise<void>;
  getWriteGuard?: () => Promise<NoteWriteGuard | undefined>;
  privateWorkspaceId?: string | null;
  privateCreationAllowed?: boolean;
  /**
   * The note a note's chat is about. That chat already holds its text, so its tools read and
   * edit it wherever it is.
   */
  openNoteId?: number | null;
}

/** Whether a note is the scope's to read or change; a note outside it is answered as not found. */
export function noteScopeCheck(
  scope: NoteScope
): (note: Pick<NoteItem, "id" | "space_id">) => boolean {
  const spaceIds = new Set(scope.spaceIds);
  return (note) =>
    (scope.openNoteId != null && note.id === scope.openNoteId) || spaceIds.has(note.space_id);
}

/** Pin writes before note/folder lookups; ordinary callers without the bridge remain compatible. */
export async function captureNoteWriteGuard(scope: NoteScope): Promise<NoteWriteGuard | undefined> {
  return scope.getWriteGuard ? scope.getWriteGuard() : window.electronAPI.getNoteWriteGuard?.();
}
