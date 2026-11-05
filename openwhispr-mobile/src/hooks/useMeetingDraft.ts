import { useCallback, useEffect, useRef, useState } from 'react';
import { useNotesStore } from '@/store/useNotesStore';

export function useMeetingDraft(
  phase: string,
  noteId: number | null,
  canWrite?: (phase: string) => boolean,
) {
  const [rawNotes, setRawNotes] = useState('');
  const lastSavedRawNotesRef = useRef('');
  const updateNote = useNotesStore((s) => s.updateNote);
  useEffect(() => {
    if (
      (phase !== 'recording' && phase !== 'cloud-recording') ||
      noteId == null ||
      rawNotes === lastSavedRawNotesRef.current
    ) {
      return;
    }

    const timeout = setTimeout(() => {
      if (canWrite && !canWrite(phase)) return;
      updateNote(noteId, { content: rawNotes });
      lastSavedRawNotesRef.current = rawNotes;
    }, 800);
    return () => clearTimeout(timeout);
  }, [noteId, phase, rawNotes, updateNote, canWrite]);

  const saveRawNotesNow = useCallback((): void => {
    if (noteId == null || rawNotes === lastSavedRawNotesRef.current) return;
    if (canWrite && !canWrite(phase)) return;
    updateNote(noteId, { content: rawNotes });
    lastSavedRawNotesRef.current = rawNotes;
  }, [noteId, rawNotes, updateNote, canWrite, phase]);

  return { rawNotes, setRawNotes, lastSavedRawNotesRef, saveRawNotesNow };
}
