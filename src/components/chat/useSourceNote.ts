import { useEffect, useMemo, useState } from "react";
import type { OpenNoteContext } from "./useChatStreaming";
import type { NoteItem } from "../../types/electron";
import { buildOpenNoteContext } from "./openNoteContext";
import { useAuth } from "../../hooks/useAuth";
import { noteChatTranscript } from "../../utils/transcriptEvidence";
import { parseTranscriptSegments } from "../../utils/parseTranscriptSegments";
import { parseNoteParticipants } from "../../utils/noteAttendees";
import { isNoteRecorder, resolveNoteRecorder } from "../../utils/noteRecorder";

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
  speakerMappings: Record<string, string>;
}

interface UseSourceNoteResult {
  sourceNote: SourceNote | null;
  /** Grounds the chat in its note, as the note's own chat is; absent once the note is deleted. */
  openNote?: (maxTranscriptTokens: number) => OpenNoteContext;
}

/**
 * The note a Chat-section conversation was started from, if it still exists.
 * `noteId` is undefined while the conversation loads.
 */
export function useSourceNote(noteId: number | null | undefined): UseSourceNoteResult {
  const { user } = useAuth();
  const [loaded, setLoaded] = useState<LoadedNote | null>(null);
  // Bumped when the note changes elsewhere (an assistant edit, a sync pull, a delete).
  const [revision, setRevision] = useState(0);

  if (noteId === null && loaded !== null) setLoaded(null);

  useEffect(() => {
    if (noteId == null) return;
    const refresh = (changed: { id: number } | null) => {
      if (changed?.id === noteId) setRevision((value) => value + 1);
    };
    const disposers = [
      window.electronAPI?.onNoteUpdated?.(refresh),
      window.electronAPI?.onNoteSynced?.(refresh),
      window.electronAPI?.onNoteDeleted?.(refresh),
    ];
    return () => disposers.forEach((dispose) => dispose?.());
  }, [noteId]);

  useEffect(() => {
    if (noteId == null) return;
    let cancelled = false;
    void (async () => {
      const [note, mappings] = await Promise.all([
        window.electronAPI?.getNote?.(noteId).catch(() => null),
        // Saved names only relabel speakers; without them the transcript still reads.
        window.electronAPI?.getSpeakerMappings?.(noteId).catch(() => []),
      ]);
      if (cancelled) return;
      setLoaded(
        note
          ? {
              noteId,
              note,
              speakerMappings: Object.fromEntries(
                (mappings ?? []).map((mapping) => [mapping.speaker_id, mapping.display_name])
              ),
            }
          : null
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, revision]);

  const userId = user?.id;
  const userName = user?.name;
  const userEmail = user?.email;

  return useMemo(() => {
    // While the next conversation loads, its bar keeps the last note's rather
    // than flashing; only a note loaded for this conversation grounds a send.
    if (!loaded || noteId === null) return { sourceNote: null };
    const { note, speakerMappings } = loaded;
    const deleted = note.deleted_at != null;
    const sourceNote: SourceNote = {
      id: note.id,
      title: note.title,
      folderId: note.folder_id,
      spaceId: note.space_id ?? null,
      deleted,
    };
    if (deleted || loaded.noteId !== noteId) return { sourceNote };

    // As the note's own chat (NoteEditor): the transcript says who took the notes.
    const recordedByUser = isNoteRecorder(note, userId);
    const owner = recordedByUser
      ? resolveNoteRecorder({
          recordedByUser,
          user: { name: userName, email: userEmail },
          recorder: undefined,
          participants: parseNoteParticipants(note.participants),
        })
      : null;
    const transcript =
      noteChatTranscript(parseTranscriptSegments(note.transcript || ""), speakerMappings, owner) ??
      note.transcript ??
      "";
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
  }, [loaded, noteId, userId, userName, userEmail]);
}
