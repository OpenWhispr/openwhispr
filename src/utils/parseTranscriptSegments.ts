import type { TranscriptSegment } from "../hooks/useMeetingTranscription";
import logger from "./logger";
export function parseTranscriptSegments(raw: string): TranscriptSegment[] {
  if (!raw.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{
      text: string;
      source: "mic" | "system";
      timestamp?: number;
    }>;
    return parsed.map((s, i) => ({
      id: `stored-${i}`,
      text: s.text,
      source: s.source,
      timestamp: s.timestamp,
    }));
  } catch (e) {
    logger.warn("Failed to parse transcript segments", e);
    return [];
  }
}
