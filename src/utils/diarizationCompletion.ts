// Routing rules for meeting-diarization-complete events (issue #1495): a result
// must be persisted to the note that owns the recording session, never to
// whichever note happens to be rendered when the event arrives.
//
// Persistence runs at store level (meetingRecordingStore) so results survive the
// notes view unmounting; `isCurrentSession` gates only the publish to the UI.

export interface DiarizationCompletionPlan {
  targetNoteId: number | null;
  isCurrentSession: boolean;
}

export function resolveDiarizationTarget(params: {
  payloadNoteId?: number | null;
  payloadSessionId?: string | null;
  currentSessionId: string | null;
  // The note a *live* recording is writing to, or null when nothing is
  // recording. Not simply the store's recordingNoteId, which outlives the
  // recording that set it.
  activeRecordingNoteId?: number | null;
}): DiarizationCompletionPlan {
  const { payloadNoteId, payloadSessionId, currentSessionId, activeRecordingNoteId } = params;
  const targetNoteId = payloadNoteId ?? null;
  // Resuming a note starts a recording that resets currentSessionId to null, so
  // "nothing pending" alone no longer means "safe to publish": the result would
  // paint the finished half over the recording that is still appending to the
  // same note, and the editor prefers that overlay to the note's own text.
  const supersededByLiveRecording = targetNoteId !== null && activeRecordingNoteId === targetNoteId;

  return {
    targetNoteId,
    // A null current session otherwise means nothing newer is pending, so
    // publishing is safe and clearing a waiting spinner prevents it sticking.
    isCurrentSession:
      !supersededByLiveRecording &&
      (currentSessionId == null || payloadSessionId === currentSessionId),
  };
}

export function selectBaseSegments<Segment>(params: {
  persistedSegments: Segment[] | null;
  liveSegments: Segment[];
  recordingNoteId: number | null;
  targetNoteId: number;
}): Segment[] {
  const { persistedSegments, liveSegments, recordingNoteId, targetNoteId } = params;

  if (persistedSegments) return persistedSegments;
  // Live segments belong to the recording note; merging them into any other
  // note would cross-contaminate transcripts.
  if (recordingNoteId === targetNoteId && liveSegments.length > 0) return liveSegments;
  return [];
}
