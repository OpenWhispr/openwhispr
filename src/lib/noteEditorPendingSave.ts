export interface NoteEditorDraft {
  readonly noteId: number;
  readonly title: string;
  readonly content: string;
  readonly enhancedContent: string | null;
}

export type NoteDraftMutation =
  | { sourceNoteId: number; field: "title" | "content"; value: string }
  | { sourceNoteId: number; field: "enhancedContent"; value: string | null };

export interface PendingDocumentSnapshot {
  readonly noteId: number;
  readonly title: string;
  readonly content: string;
  /**
   * The user edited the notes before this save. Otherwise the save writes only
   * the title: the draft's notes may predate a pull or ack the store applied
   * meanwhile, and writing them back would undo it (a cleared field would
   * return as an edit).
   */
  readonly contentEdited: boolean;
  /** The user emptied the notes, so the save is a deliberate clear that syncs. */
  readonly clearContent: boolean;
}

export interface PendingEnhancedSnapshot {
  readonly noteId: number;
  readonly enhancedContent: string | null;
}

export type PendingNoteUpdates = {
  readonly title?: string;
  readonly content?: string;
  readonly enhanced_content?: string | null;
  readonly clear_fields?: Array<"content" | "enhanced_content">;
};

export interface PendingNoteWrite {
  readonly noteId: number;
  readonly updates: PendingNoteUpdates;
}

interface NoteDraftSource {
  readonly id: number;
  readonly title: string;
  readonly content: string;
  readonly enhanced_content: string | null;
}

export interface NoteTransitionPlan {
  readonly writes: PendingNoteWrite[];
  readonly nextDraft: NoteEditorDraft | null;
}

export function shouldCancelPendingSavesForDelete(
  activeNoteId: number | null,
  deletedNoteId: number
): boolean {
  return activeNoteId === deletedNoteId;
}

export function applyNoteDraftMutation(
  draft: NoteEditorDraft | null,
  mutation: NoteDraftMutation
): NoteEditorDraft | null {
  if (!draft || mutation.sourceNoteId !== draft.noteId) return null;

  if (mutation.field === "enhancedContent") {
    return { ...draft, enhancedContent: mutation.value };
  }

  return { ...draft, [mutation.field]: mutation.value };
}

export function documentSaveUpdates(document: PendingDocumentSnapshot): PendingNoteUpdates {
  if (!document.contentEdited && !document.clearContent) return { title: document.title };
  return {
    title: document.title,
    content: document.content,
    ...(document.clearContent && { clear_fields: ["content"] }),
  };
}

export function enhancedSaveUpdates(enhanced: PendingEnhancedSnapshot): PendingNoteUpdates {
  return {
    enhanced_content: enhanced.enhancedContent,
    ...(!enhanced.enhancedContent?.trim() && { clear_fields: ["enhanced_content"] }),
  };
}

export function collectPendingNoteWrites(
  document: PendingDocumentSnapshot | null,
  enhanced: PendingEnhancedSnapshot | null
): PendingNoteWrite[] {
  if (document && enhanced && document.noteId === enhanced.noteId) {
    const documentUpdates = documentSaveUpdates(document);
    const enhancedUpdates = enhancedSaveUpdates(enhanced);
    const clearFields = [
      ...(documentUpdates.clear_fields ?? []),
      ...(enhancedUpdates.clear_fields ?? []),
    ];
    return [
      {
        noteId: document.noteId,
        updates: {
          ...documentUpdates,
          ...enhancedUpdates,
          ...(clearFields.length > 0 && { clear_fields: clearFields }),
        },
      },
    ];
  }

  const writes: PendingNoteWrite[] = [];
  if (document) writes.push({ noteId: document.noteId, updates: documentSaveUpdates(document) });
  if (enhanced) writes.push({ noteId: enhanced.noteId, updates: enhancedSaveUpdates(enhanced) });
  return writes;
}

export function planNoteTransition(
  nextNote: NoteDraftSource | null,
  document: PendingDocumentSnapshot | null,
  enhanced: PendingEnhancedSnapshot | null
): NoteTransitionPlan {
  return {
    writes: collectPendingNoteWrites(document, enhanced),
    nextDraft: nextNote
      ? {
          noteId: nextNote.id,
          title: nextNote.title,
          content: nextNote.content,
          enhancedContent: nextNote.enhanced_content ?? null,
        }
      : null,
  };
}
