import { parseTranscriptSegments } from "./parseTranscriptSegments";
import { withoutAttendeesFence } from "./noteAttendees";
import { resolveSegmentSpeakerName } from "./transcriptSpeakerState";
import { buildMeetingContext, type MeetingIdentity } from "./llmTranscript";
import i18n from "../i18n";
import type { TranscriptSegment } from "../stores/meetingRecordingStore";

const TRANSCRIPT_PAGE_LENGTH = 500;
// Text shown before a match, so the passage starts with what led up to it.
const MATCH_LEAD_IN = 100;

/**
 * Largest transcript, in estimated tokens (`estimateNoteTokens`), a note's chat
 * sends whole. Longer ones, when the model can call get_note, get a preview and
 * are read through retrieval. Counted in tokens because CJK text takes about a
 * token per character. A hosted model takes an hour-long meeting (~55k
 * characters) whole and stays inside a 131k-token context.
 *
 * llama-server starts at a 16,384-token context. A local note chat with nine
 * tools, its note and the 4,096-token output reserve measured ~9.2k estimated
 * tokens before any transcript and ~13.1k with one at this budget, leaving ~3k
 * for later turns, get_note results and the passages kept. Sending more whole
 * would trade that headroom for requests that overflow the context outright,
 * so longer transcripts on a local or LAN model are read through retrieval.
 */
export const FULL_TRANSCRIPT_MAX_TOKENS = { hosted: 64_000, selfHosted: 4_000 } as const;

export interface ReadableTranscript {
  text: string;
  references: Array<{ start: number; end: number; timestamp_seconds?: number }>;
}

// Whoever recorded the note: the user on their own notes, a teammate on a shared one.
export const NOTE_TAKER_LABEL = "Note taker";

// Never split a surrogate pair at a cut.
function codePointBoundary(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && index < text.length && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

function speakerLabel(segment: TranscriptSegment, speakerMappings: Record<string, string>): string {
  // Stored JSON is untrusted: a malformed name must not block the transcript.
  const resolved: unknown = resolveSegmentSpeakerName(segment, speakerMappings);
  if (typeof resolved === "string" && resolved) {
    // A speaker mapped to "You" is stored in the UI language.
    const name = resolved.trim().toLowerCase();
    return name === "you" || name === i18n.t("notes.speaker.you").toLowerCase()
      ? NOTE_TAKER_LABEL
      : resolved;
  }
  if (segment.speaker === "you") return NOTE_TAKER_LABEL;
  // Numbered from 1, as the note shows speakers. An in-person meeting is
  // diarized on the mic, so a numbered mic speaker isn't the note taker.
  const numbered = typeof segment.speaker === "string" && /^speaker_(\d+)$/.exec(segment.speaker);
  if (numbered) return `Speaker ${Number(numbered[1]) + 1}`;
  if (segment.source === "mic") return NOTE_TAKER_LABEL;
  if (typeof segment.speaker === "string" && segment.speaker) return segment.speaker;
  return segment.source === "system" ? "Others" : "";
}

/**
 * One `Speaker: text` line per stored segment, so speakers can be searched;
 * plain-text transcripts are returned as they are. Offsets count this text,
 * never the stored JSON.
 */
export function readableTranscript(
  raw: string,
  speakerMappings: Record<string, string> = {}
): ReadableTranscript {
  return (
    readableSegments(parseTranscriptSegments(raw), speakerMappings) ?? {
      text: withoutAttendeesFence(raw),
      references: [],
    }
  );
}

// Says whether the note taker is the user, so "my" questions reach the right lines.
function noteTakerContext(owner: MeetingIdentity | null): string {
  if (!owner) {
    return `## Meeting Context\nSomeone other than the user took these notes ("${NOTE_TAKER_LABEL}" in the transcript).`;
  }
  return (
    buildMeetingContext({ ...owner, participants: [] }, NOTE_TAKER_LABEL) ||
    `## Meeting Context\nThe user took these notes ("${NOTE_TAKER_LABEL}" in the transcript).`
  );
}

/**
 * The open note's transcript for its chat, labelled as get_note labels it, so a
 * speaker the model sees can be searched for, after a line saying who the note
 * taker is. `owner` is the user on their own note, null on someone else's;
 * invitees are left to the filtered attendee block that comes with connector
 * tools. Null when there are no segments to label.
 */
export function noteChatTranscript(
  segments: TranscriptSegment[],
  speakerMappings: Record<string, string>,
  owner: MeetingIdentity | null
): string | null {
  const transcript = readableSegments(segments, speakerMappings);
  if (!transcript) return null;
  return `${noteTakerContext(owner)}\n\n${transcript.text}`;
}

// Null when no segment has text.
function readableSegments(
  allSegments: TranscriptSegment[],
  speakerMappings: Record<string, string>
): ReadableTranscript | null {
  const segments = allSegments.filter((segment) => typeof segment.text === "string");
  if (!segments.length) return null;
  const firstTimestamp = segments.reduce(
    (first, segment) =>
      Number.isFinite(segment.timestamp) ? Math.min(first, segment.timestamp as number) : first,
    Infinity
  );
  let position = 0;
  const lines: string[] = [];
  const references = segments.map((segment) => {
    const fullLabel = speakerLabel(segment, speakerMappings);
    const label = fullLabel.slice(0, codePointBoundary(fullLabel, 80));
    const line = withoutAttendeesFence(label ? `${label}: ${segment.text}` : segment.text);
    lines.push(line);
    const start = position;
    position += line.length + 1;
    return {
      start,
      end: start + line.length,
      // Live recordings store epoch milliseconds; diarized and uploaded ones, seconds from the start.
      timestamp_seconds: Number.isFinite(segment.timestamp)
        ? firstTimestamp > 1e9
          ? ((segment.timestamp as number) - firstTimestamp) / 1000
          : segment.timestamp
        : undefined,
    };
  });
  return { text: lines.join("\n"), references };
}

export function transcriptPreview(text: string): string {
  return text.slice(0, codePointBoundary(text, TRANSCRIPT_PAGE_LENGTH));
}

/**
 * A literal, case-insensitive search: words in the query match across any run
 * of whitespace, line breaks included. The escaped regex keeps source offsets
 * even for characters whose lowercase spelling changes length.
 */
function literalPattern(query: string): RegExp {
  const words = query
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(words.join("\\s+"), "giu");
}

interface TranscriptPage {
  transcript: string;
  transcript_start: number;
  transcript_end: number;
  transcript_length: number;
  transcript_truncated: boolean;
  transcript_next_offset: number | null;
  transcript_match_found?: boolean;
  /** When the passage's earliest and latest timed lines were spoken. */
  transcript_time_seconds?: { start: number; end: number };
}

export function transcriptPage(
  { text, references }: ReadableTranscript,
  offset = 0,
  query?: string
): TranscriptPage {
  const pattern = query ? literalPattern(query) : null;
  const match = pattern ? (text.slice(offset).matchAll(pattern).next().value ?? null) : null;
  const found = query === undefined || match !== null;
  const matchStart = match ? offset + match.index : offset;
  const start = codePointBoundary(
    text,
    Math.min(text.length, match ? Math.max(offset, matchStart - MATCH_LEAD_IN) : offset)
  );
  const end = found
    ? codePointBoundary(text, Math.min(text.length, start + TRANSCRIPT_PAGE_LENGTH))
    : start;
  // A query continues after the last match the passage shows whole, so each
  // call reaches new text; a match cut off at the end is found again.
  let nextOffset = found ? end : null;
  if (pattern) {
    for (const shown of text.slice(start, end).matchAll(pattern)) {
      nextOffset = start + shown.index + shown[0].length;
    }
    // Continuing is only worth a call when another match follows.
    if (nextOffset !== null && text.slice(nextOffset).search(pattern) === -1) nextOffset = null;
  }
  const times = references
    .filter((line) => line.end > start && line.start < end)
    .flatMap((line) => line.timestamp_seconds ?? []);
  return {
    transcript: text.slice(start, end),
    transcript_start: start,
    transcript_end: end,
    transcript_length: text.length,
    transcript_truncated: start > 0 || end < text.length,
    transcript_next_offset: nextOffset !== null && nextOffset < text.length ? nextOffset : null,
    ...(query === undefined ? {} : { transcript_match_found: found }),
    ...(times.length
      ? { transcript_time_seconds: { start: Math.min(...times), end: Math.max(...times) } }
      : {}),
  };
}

async function prefixDigest(text: string, length: number): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text.slice(0, length))
  );
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * Names the text read so far (`<length>.<digest>`), not the whole transcript:
 * a recording in progress keeps appending, and its earlier offsets stay valid.
 */
export async function transcriptRevision(text: string, readTo: number): Promise<string> {
  return `${readTo}.${await prefixDigest(text, readTo)}`;
}

const REVISION_PATTERN = /^(\d+)\.([0-9a-f]{16})$/;

export function isTranscriptRevision(revision: string): boolean {
  return REVISION_PATTERN.test(revision);
}

export async function isTranscriptRevisionCurrent(
  text: string,
  revision: string
): Promise<boolean> {
  const parsed = REVISION_PATTERN.exec(revision);
  if (!parsed) return false;
  const readTo = Number(parsed[1]);
  return readTo <= text.length && (await prefixDigest(text, readTo)) === parsed[2];
}
