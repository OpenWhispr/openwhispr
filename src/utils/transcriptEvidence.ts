import { parseTranscriptSegments } from "./parseTranscriptSegments";
import { withoutAttendeesFence } from "./noteAttendees";
import { resolveSegmentSpeakerName } from "./transcriptSpeakerState";

export const TRANSCRIPT_PAGE_LENGTH = 500;
const MAX_SEGMENT_REFERENCES = 8;

/** Offsets refer to this readable text, never to the stored JSON. */
function transcriptEvidence(raw: string, speakerMappings: Record<string, string> = {}) {
  const segments = parseTranscriptSegments(raw);
  const firstTimestamp = segments.reduce(
    (first, segment) =>
      typeof segment.timestamp === "number" && Number.isFinite(segment.timestamp)
        ? Math.min(first, segment.timestamp)
        : first,
    Infinity
  );
  let position = 0;
  const references = segments
    .filter((segment) => typeof segment.text === "string")
    .map((segment) => {
      const text = withoutAttendeesFence(segment.text);
      const start = position;
      position += text.length + 1;
      return {
        text,
        start,
        end: start + text.length,
        speaker: withoutAttendeesFence(
          [
            resolveSegmentSpeakerName(segment, speakerMappings),
            segment.speaker,
            segment.source,
          ].find((label): label is string => typeof label === "string" && label.length > 0) ?? ""
        ).slice(0, 80),
        timestamp_seconds:
          typeof segment.timestamp === "number" && Number.isFinite(segment.timestamp)
            ? firstTimestamp > 1e9
              ? (segment.timestamp - firstTimestamp) / 1000
              : segment.timestamp
            : undefined,
      };
    });
  const text = references.length
    ? references.map((segment) => segment.text).join("\n")
    : withoutAttendeesFence(raw);
  return { text, references };
}

export function transcriptPage(
  raw: string,
  offset = 0,
  query?: string,
  speakerMappings?: Record<string, string>
) {
  const { text, references } = transcriptEvidence(raw, speakerMappings);
  // A literal, escaped regex preserves source offsets even for Unicode characters
  // whose lowercase spelling changes length. No transcript text is executable.
  const match = query
    ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").exec(text.slice(offset))
    : null;
  const found = query === undefined || match !== null;
  const start = found
    ? Math.min(text.length, query ? Math.max(offset, offset + match!.index - 100) : offset)
    : Math.min(offset, text.length);
  const end = found ? Math.min(text.length, start + TRANSCRIPT_PAGE_LENGTH) : start;
  const overlapping = references.filter((segment) => segment.end > start && segment.start < end);
  return {
    transcript: text.slice(start, end),
    transcript_start: start,
    transcript_end: end,
    transcript_length: text.length,
    transcript_truncated: start > 0 || end < text.length,
    transcript_next_offset: !found
      ? null
      : query
        ? offset + match!.index + match![0].length < text.length
          ? offset + match!.index + match![0].length
          : null
        : end < text.length
          ? end
          : null,
    ...(query === undefined ? {} : { transcript_match_found: found }),
    ...(overlapping.length
      ? {
          transcript_segments: overlapping
            .slice(0, MAX_SEGMENT_REFERENCES)
            .map(({ text: _, ...reference }) => reference),
          transcript_segments_truncated: overlapping.length > MAX_SEGMENT_REFERENCES,
        }
      : {}),
  };
}
