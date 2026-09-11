import type { MeetingAudioRecording } from "../types/meetingAudio";
export function resolveAudioSeek(
  recordings: MeetingAudioRecording[],
  segment: { source: string; timestamp?: number }
) {
  if (segment.timestamp == null || !Number.isFinite(segment.timestamp)) return null;
  for (const recording of recordings) {
    const track = recording.tracks.find((track) => track.source === segment.source);
    if (!track || track.durationSeconds == null) continue;
    const seconds = (segment.timestamp - track.startedAt) / 1000;
    if (seconds >= -0.25 && seconds < track.durationSeconds)
      return { recording, track, seconds: Math.max(0, seconds) };
  }
  return null;
}
