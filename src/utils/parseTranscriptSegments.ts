import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { normalizeTranscriptSegments } from "./transcriptSpeakerState";
import logger from "./logger";
export function parseTranscriptSegments(raw: string): TranscriptSegment[] {
  if (!raw.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{
      text: string;
      source: "mic" | "system";
      timestamp?: number;
      speaker?: string;
      speakerName?: string;
      speakerIsPlaceholder?: boolean;
      suggestedName?: string;
      suggestedProfileId?: number;
      speakerStatus?: TranscriptSegment["speakerStatus"];
      speakerLocked?: TranscriptSegment["speakerLocked"];
      speakerLockSource?: TranscriptSegment["speakerLockSource"];
    }>;
    return normalizeTranscriptSegments(
      parsed.map((s, i) => ({
        id: `stored-${i}`,
        text: s.text,
        source: s.source,
        timestamp: s.timestamp,
        speaker: s.speaker,
        speakerName: s.speakerName,
        speakerIsPlaceholder: s.speakerIsPlaceholder,
        suggestedName: s.suggestedName,
        suggestedProfileId: s.suggestedProfileId,
        speakerStatus: s.speakerStatus,
        speakerLocked: s.speakerLocked,
        speakerLockSource: s.speakerLockSource,
      }))
    );
  } catch (e) {
    logger.warn("Failed to parse transcript segments", e);
    return [];
  }
}

const isJsonArray = (raw: string): boolean => {
  try {
    return Array.isArray(JSON.parse(raw));
  } catch {
    return false;
  }
};

/**
 * Segments to seed a recording into a note with. Every save of that recording
 * writes its segments over the stored transcript, so a plain-text one (v1.6.0–
 * v1.6.5 meetings, or a recording with no segments) is carried as one segment.
 * It has no timestamp or speaker: live speaker identification skips it, new
 * finals sort after it, and export keeps rebasing on the new segments' times.
 */
export function parseSeedSegments(raw: string | null | undefined): TranscriptSegment[] {
  const text = raw?.trim();
  if (!text) return [];
  if (isJsonArray(text)) return parseTranscriptSegments(text);
  return [{ id: "stored-plain", text, source: "system" }];
}
