import type { TranscriptSegment } from "../stores/meetingRecordingStore";

// The final transcript is persisted from the store's stop path, not from a
// notes-view effect: a recording can stop without the user driving it
// (auto-end, owner loss) while another view is open, and any persistence keyed
// to a mounted editor would silently drop the tail since the last periodic
// save. Delayed diarization results are handled by the store's #1495 listener.
export function buildFinalMeetingTranscript(
  segments: TranscriptSegment[],
  fallbackTranscript: string,
  serializeSegments: (segments: TranscriptSegment[]) => string
): string | null {
  if (segments.length > 0) return serializeSegments(segments);
  return fallbackTranscript || null;
}
