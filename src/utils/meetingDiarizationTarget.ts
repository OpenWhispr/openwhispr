interface DiarizationIdentity {
  sessionId?: string | null;
  noteId?: number | null;
  clientNoteId?: string | null;
}

export function matchesMeetingDiarizationTarget(
  result: DiarizationIdentity | null | undefined,
  target: DiarizationIdentity
): boolean {
  return (
    !!result?.sessionId &&
    result.sessionId === target.sessionId &&
    result.noteId === target.noteId &&
    result.clientNoteId === target.clientNoteId
  );
}
