import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { NoteItem } from "../types/electron";
import {
  revealContainer,
  setActiveContext,
  setActiveNoteId,
  useActiveContext,
} from "../stores/noteStore";
import { startRecording, useMeetingRecordingStore } from "../stores/meetingRecordingStore";
import { useTranscriptionContextAllowed } from "./usePolicy";
import { parseTranscriptSegments } from "../utils/parseTranscriptSegments";
import { isExplicitSpeakerCount, resolveExpectedSpeakerCount } from "../utils/participants";
import { isMeetingAutoEndEligible } from "../helpers/meetingRecordingSession";

/** Start a meeting recording seeded with the note's transcript and speaker setup. */
export function startRecordingForNote(note: NoteItem | null): Promise<boolean> {
  return startRecording({
    noteId: note?.id ?? null,
    noteTitle: note?.title ?? null,
    folderId: note?.folder_id ?? null,
    seedSegments: note?.transcript ? parseTranscriptSegments(note.transcript) : [],
    diarizationEnabled: note?.diarization_enabled == null ? null : note.diarization_enabled === 1,
    expectedCount: resolveExpectedSpeakerCount(note),
    expectedCountIsExplicit: isExplicitSpeakerCount(note?.expected_speaker_count),
    autoEndEligible: isMeetingAutoEndEligible(note),
  });
}

/**
 * Creates a note, opens it in the tree, and starts recording into it. Usable
 * from any view: a null space resolves to the private space in the database,
 * so nothing here depends on the Notes tree having loaded.
 */
export function useCreateNote() {
  const { t } = useTranslation();
  const activeContext = useActiveContext();
  const isRecording = useMeetingRecordingStore((s) => s.isRecording);
  const recordingAllowed = useTranscriptionContextAllowed("meeting");

  const createNoteIn = useCallback(
    async (spaceId: number | null, folderId: number | null) => {
      const result = await window.electronAPI.saveNote(
        t("notes.list.untitledNote"),
        "",
        "personal",
        null,
        null,
        folderId,
        spaceId
      );
      if (!result.success || !result.note) return;
      setActiveContext(result.note.space_id, result.note.folder_id);
      revealContainer(result.note.space_id, result.note.folder_id);
      setActiveNoteId(result.note.id);
      // A new note is a recording waiting to happen: start it unless one is already live.
      if (recordingAllowed && !isRecording) void startRecordingForNote(result.note);
    },
    [t, recordingAllowed, isRecording]
  );

  /** Creates in the active container, or the private space when none is selected. */
  const createNote = useCallback(
    () => createNoteIn(activeContext?.spaceId ?? null, activeContext?.folderId ?? null),
    [activeContext, createNoteIn]
  );

  return { createNote, createNoteIn };
}
