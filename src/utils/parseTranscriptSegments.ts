import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { normalizeTranscriptSegments } from "./transcriptSpeakerState.ts";
import logger from "./logger.ts";

export function parseTranscriptSegments(raw: string): TranscriptSegment[] {
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[")) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return [];

    const validItems = parsed.filter(
      (s): s is Record<string, unknown> => s !== null && typeof s === "object"
    );

    return normalizeTranscriptSegments(
      validItems.map((s, i) => ({
        id: `stored-${i}`,
        text: typeof s.text === "string" ? s.text : "",
        source: (s.source === "system" ? "system" : "mic") as "mic" | "system",
        timestamp: typeof s.timestamp === "number" ? s.timestamp : undefined,
        speaker: typeof s.speaker === "string" ? s.speaker : undefined,
        speakerName: typeof s.speakerName === "string" ? s.speakerName : undefined,
        speakerIsPlaceholder:
          typeof s.speakerIsPlaceholder === "boolean" ? s.speakerIsPlaceholder : undefined,
        suggestedName: typeof s.suggestedName === "string" ? s.suggestedName : undefined,
        suggestedProfileId:
          typeof s.suggestedProfileId === "number" ? s.suggestedProfileId : undefined,
        speakerStatus: s.speakerStatus as TranscriptSegment["speakerStatus"],
        speakerLocked: s.speakerLocked as TranscriptSegment["speakerLocked"],
        speakerLockSource: s.speakerLockSource as TranscriptSegment["speakerLockSource"],
      }))
    );
  } catch (e) {
    logger.warn("Failed to parse transcript segments", e);
    return [];
  }
}
