import type { TranscriptSegment } from "../stores/meetingRecordingStore";

// The final transcript is persisted from the store's stop path, not from a
// notes-view effect: a recording can stop without the user driving it
// (auto-end, owner loss) while another view is open, and any persistence keyed
// to a mounted editor would silently drop the tail since the last periodic
// save. Delayed diarization results are handled by the store's #1495 listener.
//
// The captured segments are final the moment the stop begins, and the note
// editor swaps to the stored transcript as soon as isRecording flips — so they
// are written before the main-side stop (which can take seconds) is awaited.
// Only a segment-less recording waits for main's final transcript.
export async function persistFinalTranscriptAroundStop<T>({
  segments,
  serializeSegments,
  persist,
  stop,
  fallbackTranscript,
}: {
  segments: TranscriptSegment[];
  serializeSegments: (segments: TranscriptSegment[]) => string;
  persist: (transcript: string) => Promise<void>;
  stop: () => Promise<T>;
  fallbackTranscript: () => string;
}): Promise<T> {
  const segmentWrite = segments.length > 0 ? persist(serializeSegments(segments)) : null;

  const result = await stop();

  if (segmentWrite) {
    await segmentWrite;
  } else {
    const fallback = fallbackTranscript();
    if (fallback) await persist(fallback);
  }
  return result;
}
