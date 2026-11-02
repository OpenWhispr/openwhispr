import { useEffect, useMemo, useRef, useState } from "react";
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
  userId: string | null;
  revision: number;
  note: NoteItem | null;
  speakerMappings: Record<string, string>;
}

interface UseSourceNoteResult {
  sourceNote: SourceNote | null;
  isLoading: boolean;
  /** Grounds the chat in its note, as the note's own chat is; absent once the note is deleted. */
  openNote?: (maxTranscriptTokens: number) => OpenNoteContext;
}

/**
 * The note a Chat-section conversation was started from, if it still exists.
 * `noteId` is undefined while the conversation loads.
 */
export function useSourceNote(noteId: number | null | undefined): UseSourceNoteResult {
  const { user, isLoaded: authLoaded } = useAuth();
  const userId = user?.id ?? null;
  const targetRef = useRef({ noteId, userId, authLoaded });
  targetRef.current = { noteId, userId, authLoaded };
  const [loaded, setLoaded] = useState<LoadedNote | null>(null);
  // Bumped when the note changes elsewhere (an assistant edit, a sync pull, a delete).
  const [revision, setRevision] = useState(0);
  const revisionRef = useRef(0);

  if (noteId === null && loaded !== null) setLoaded(null);

  useEffect(() => {
    if (noteId === null) return;
    const invalidate = (): void => {
      // Invalidate synchronously too: a send or IPC reply may already be preparing.
      revisionRef.current += 1;
      setRevision(revisionRef.current);
    };
    const refresh = (changed: { id: number } | null): void => {
      if (noteId === undefined || changed?.id === noteId) invalidate();
    };
    const disposers = [
      window.electronAPI?.onNoteUpdated?.(refresh),
      window.electronAPI?.onNoteSynced?.(refresh),
      window.electronAPI?.onNoteDeleted?.(refresh),
      // A pending fetch has no container metadata yet, so recheck on any removal.
      window.electronAPI?.onSpacePurged?.(invalidate),
      window.electronAPI?.onFolderDeleted?.(invalidate),
    ];
    return () => disposers.forEach((dispose) => dispose?.());
  }, [noteId]);

  useEffect(() => {
    if (noteId == null || !authLoaded) return;
    let cancelled = false;
    void (async () => {
      const [note, mappings] = await Promise.all([
        window.electronAPI?.getNote?.(noteId).catch(() => null),
        // Saved names only relabel speakers; without them the transcript still reads.
        window.electronAPI?.getSpeakerMappings?.(noteId).catch(() => []),
      ]);
      if (cancelled || revision !== revisionRef.current) return;
      setLoaded({
        noteId,
        userId,
        revision,
        note: note ?? null,
        speakerMappings: Object.fromEntries(
          (mappings ?? []).map((mapping) => [mapping.speaker_id, mapping.display_name])
        ),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, revision, userId, authLoaded]);
  const userName = user?.name;
  const userEmail = user?.email;

  return useMemo(() => {
    // While the next conversation loads, its bar keeps the last note's rather
    // than flashing; only a note loaded for this conversation grounds a send.
    const isLoading =
      noteId === undefined ||
      (noteId !== null &&
        (!authLoaded ||
          !loaded ||
          loaded.noteId !== noteId ||
          loaded.userId !== userId ||
          loaded.revision !== revision));
    if (
      !loaded?.note ||
      noteId === null ||
      !authLoaded ||
      loaded.userId !== userId ||
      loaded.revision !== revision
    ) {
      return { sourceNote: null, isLoading };
    }
    const { note, speakerMappings } = loaded;
    const deleted = note.deleted_at != null;
    const sourceNote: SourceNote = {
      id: note.id,
      title: note.title,
      folderId: note.folder_id,
      spaceId: note.space_id ?? null,
      deleted,
    };
    if (deleted || loaded.noteId !== noteId) return { sourceNote, isLoading };

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
      isLoading,
      openNote: (maxTranscriptTokens: number): OpenNoteContext => {
        const target = targetRef.current;
        if (
          revisionRef.current !== loaded.revision ||
          target.noteId !== loaded.noteId ||
          target.userId !== loaded.userId ||
          !target.authLoaded
        ) {
          return { text: "", transcriptPreview: false };
        }
        return buildOpenNoteContext(
          {
            id: note.id,
            folderId: note.folder_id,
            title: note.title,
            content: note.content,
            summary: note.enhanced_content ?? "",
            transcript,
          },
          maxTranscriptTokens
        );
      },
    };
  }, [loaded, noteId, revision, authLoaded, userId, userName, userEmail]);
}
