import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useMeetingRecordingStore } from "../stores/meetingRecordingStore";

interface MeetingNoteSession {
  id: string;
  noteId: number;
}

export function useMeetingNoteSession(
  activeView: string,
  activeNoteId: number | null
): RefObject<MeetingNoteSession | null> {
  const sessionRef = useRef<MeetingNoteSession | null>(null);
  const isRecording = useMeetingRecordingStore((state) => state.isRecording);
  const closeSession = useCallback((): void => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) void window.electronAPI?.meetingNoteClosed?.(session.id);
  }, []);
  useEffect(() => {
    const session = sessionRef.current;
    // A start still running keeps the session even after the user moves on: main
    // releases it when the recording registers, and a failed start ends up here.
    if (
      session &&
      !isRecording &&
      (activeView !== "personal-notes" || activeNoteId !== session.noteId)
    ) {
      closeSession();
    }
  }, [activeView, activeNoteId, isRecording, closeSession]);
  useEffect(() => closeSession, [closeSession]);
  return sessionRef;
}
