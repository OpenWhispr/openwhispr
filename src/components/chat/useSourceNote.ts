import { useEffect, useMemo, useState } from "react";
import type { OpenNoteContext } from "./useChatStreaming";
import type { NoteItem } from "../../types/electron";
import { buildOpenNoteContext } from "./openNoteContext";
import { readableTranscript } from "../../utils/transcriptEvidence";

export interface SourceNote {
  id: number;
  title: string;
  folderId: number | null;
  spaceId: number | null;
  deleted: boolean;
}

interface LoadedNote {
  noteId: number;
  note: NoteItem;
  transcript: string;
}

interface UseSourceNoteResult {
  sourceNote: SourceNote | null;
  /** Grounds the chat in its note, as the note's own chat is; absent once the note is deleted. */
  openNote?: (maxTranscriptTokens: number) => OpenNoteContext;
}

/** The note a Chat-section conversation was started from, if it still exists. */
export function useSourceNote(noteId: number | null): UseSourceNoteResult {
  const [loaded, setLoaded] = useState<LoadedNote | null>(null);

  useEffect(() => {
    if (noteId === null) return;
    let cancelled = false;
    void (async () => {
      const note = await window.electronAPI?.getNote?.(noteId).catch(() => null);
      if (cancelled) return;
      if (!note) {
        setLoaded(null);
        return;
      }
      // Saved names only relabel speakers; without them the transcript still reads.
      const mappings = await window.electronAPI?.getSpeakerMappings?.(noteId).catch(() => []);
      if (cancelled) return;
      const transcript = readableTranscript(
        note.transcript ?? "",
        Object.fromEntries(
          (mappings ?? []).map((mapping) => [mapping.speaker_id, mapping.display_name])
        )
      ).text;
      setLoaded({ noteId, note, transcript });
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  // A note fetched for the previous conversation never stands in for this one's.
  const current = noteId !== null && loaded?.noteId === noteId ? loaded : null;

  return useMemo(() => {
    if (!current) return { sourceNote: null };
    const { note, transcript } = current;
    const deleted = note.deleted_at != null;
    const sourceNote: SourceNote = {
      id: note.id,
      title: note.title,
      folderId: note.folder_id,
      spaceId: note.space_id ?? null,
      deleted,
    };
    if (deleted) return { sourceNote };
    return {
      sourceNote,
      openNote: (maxTranscriptTokens: number) =>
        buildOpenNoteContext(
          {
            id: note.id,
            folderId: note.folder_id,
            title: note.title,
            content: note.content,
            summary: note.enhanced_content ?? "",
            transcript,
          },
          maxTranscriptTokens
        ),
    };
  }, [current]);
}
