import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { mergeTranscriptSegments } from "./transcriptSpeakerState";

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

export interface RemovedTranscriptSegment {
  text: string;
  source: "mic" | "system";
  timestamp?: number;
}

// Main drops echo duplicates and late retracts from its copy, so its result
// never matches those rows and the merge would keep them with their raw
// epoch-ms timestamps and no speaker (#2781). Matches on source, timestamp and
// exact text like a live retract, but removes only one persisted row per
// removed entry.
export function withoutRemovedSegments<
  Segment extends { text: string; source: string; timestamp?: number },
>(segments: Segment[], removed: RemovedTranscriptSegment[] | undefined): Segment[] {
  if (!removed?.length) return segments;

  const keyOf = (segment: Segment | RemovedTranscriptSegment): string =>
    `${segment.source}|${segment.timestamp ?? ""}|${segment.text}`;
  const pending = new Map<string, number>();
  for (const segment of removed) {
    const key = keyOf(segment);
    pending.set(key, (pending.get(key) ?? 0) + 1);
  }

  return segments.filter((segment) => {
    const key = keyOf(segment);
    const count = pending.get(key) ?? 0;
    if (count === 0) return true;
    pending.set(key, count - 1);
    return false;
  });
}

// Merges main's result into this session's rows only: the first `seedLength`
// rows are a resumed note's earlier sessions and stay as saved. `removedCount`
// is how many of this session's rows were dropped.
export function mergeSessionDiarization(params: {
  existing: TranscriptSegment[];
  seedLength: number;
  segments: Array<Omit<TranscriptSegment, "id"> & { id?: string }>;
  removedSegments?: RemovedTranscriptSegment[];
}): { segments: TranscriptSegment[]; removedCount: number } {
  const { existing, seedLength, segments, removedSegments } = params;
  const seededCount = Math.min(seedLength, existing.length);
  const sessionRows = existing.slice(seededCount);
  const keptRows = withoutRemovedSegments(sessionRows, removedSegments);
  return {
    segments: [
      ...existing.slice(0, seededCount),
      ...mergeTranscriptSegments(
        keptRows,
        segments.map((segment, index) => ({ ...segment, id: segment.id || `diarized-${index}` }))
      ),
    ],
    removedCount: sessionRows.length - keptRows.length,
  };
}
