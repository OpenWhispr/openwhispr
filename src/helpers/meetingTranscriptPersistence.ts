import type { TranscriptSegment } from "../stores/meetingRecordingStore";

// The final transcript is persisted from the store's stop path, not from a
// notes-view effect: a recording can stop without the user driving it
// (auto-end, owner loss) while another view is open, and any persistence keyed
// to a mounted editor would silently drop the tail since the last periodic
// save. Delayed diarization results are handled by the store's #1495 listener.
//
// The captured segments are written the moment the stop begins, and the note
// editor swaps to the stored transcript as soon as isRecording flips — so they
// are written before the main-side stop (which can take seconds) is awaited.
// A recording with no new segments also saves main's final transcript.
export async function persistFinalTranscriptAroundStop<T>({
  segments,
  getFinalSegments = () => segments,
  seedLength,
  serializeSegments,
  persist,
  stop,
  fallbackTranscript,
}: {
  segments: TranscriptSegment[];
  getFinalSegments?: () => TranscriptSegment[];
  seedLength: number;
  serializeSegments: (segments: TranscriptSegment[]) => string;
  persist: (transcript: string) => Promise<void>;
  stop: () => Promise<T>;
  fallbackTranscript: () => string;
}): Promise<T> {
  const segmentWrite = segments.length > 0 ? persist(serializeSegments(segments)) : null;

  const result = await stop();

  if (segmentWrite) {
    await segmentWrite;
  }
  const drainedSegments = getFinalSegments();
  if (drainedSegments !== segments) {
    // Final deltas and retractions can arrive while the provider handles end
    // of audio. Save the updated rows after the early write has settled.
    await persist(serializeSegments(drainedSegments));
  } else if (segments.length === seedLength) {
    const fallback = fallbackTranscript();
    if (fallback) await persist(fallback);
  }
  return result;
}
