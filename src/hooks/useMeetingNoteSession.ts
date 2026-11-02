import { useCallback, useEffect, useRef, type RefObject } from "react";

interface MeetingNoteSession {
  id: string;
  noteId: number;
}

export function useMeetingNoteSession(
  activeView: string,
  activeNoteId: number | null
): RefObject<MeetingNoteSession | null> {
  const sessionRef = useRef<MeetingNoteSession | null>(null);
  const closeSession = useCallback((): void => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) void window.electronAPI?.meetingNoteClosed?.(session.id);
  }, []);
  useEffect(() => {
    const session = sessionRef.current;
    if (session && (activeView !== "personal-notes" || activeNoteId !== session.noteId)) {
      closeSession();
    }
  }, [activeView, activeNoteId, closeSession]);
  useEffect(() => closeSession, [closeSession]);
  return sessionRef;
}
