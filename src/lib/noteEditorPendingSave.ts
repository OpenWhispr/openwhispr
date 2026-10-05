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
}

export interface PendingEnhancedSnapshot {
  readonly noteId: number;
  readonly enhancedContent: string | null;
}

export type PendingNoteUpdates = {
  readonly title?: string;
  readonly content?: string;
  readonly enhanced_content?: string | null;
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

export function collectPendingNoteWrites(
  document: PendingDocumentSnapshot | null,
  enhanced: PendingEnhancedSnapshot | null
): PendingNoteWrite[] {
  if (document && enhanced && document.noteId === enhanced.noteId) {
    return [
      {
        noteId: document.noteId,
        updates: {
          title: document.title,
          content: document.content,
          enhanced_content: enhanced.enhancedContent,
        },
      },
    ];
  }

  const writes: PendingNoteWrite[] = [];
  if (document) {
    writes.push({
      noteId: document.noteId,
      updates: { title: document.title, content: document.content },
    });
  }
  if (enhanced) {
    writes.push({
      noteId: enhanced.noteId,
      updates: { enhanced_content: enhanced.enhancedContent },
    });
  }
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
