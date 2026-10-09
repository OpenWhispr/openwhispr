import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import type { CalendarAttendee } from "../types/calendar";
import { resolveSegmentSpeakerName } from "./transcriptSpeakerState";
import type { MentionPerson } from "./mentionMarkdown";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface MeetingIdentity {
  selfName: string | null;
  selfEmail: string | null;
  participants: CalendarAttendee[];
}

const isSelfParticipant = (participant: CalendarAttendee, identity: MeetingIdentity) =>
  participant.self || (!!identity.selfEmail && participant.email === identity.selfEmail);

/**
 * Speaker label for the LLM payload. Mirrors the precedence the exporter
 * applies in transcriptFormatter.js: explicit name → cluster mapping →
 * "Speaker N" → source fallback. An unnamed mic track falls back to the
 * note owner's real name instead of an anonymous "You" whenever it is known.
 */
export function resolveLlmSpeakerLabel(
  segment: TranscriptSegment,
  speakerMappings: Record<string, string>,
  selfLabel: string,
  t: Translate
): string {
  const resolved = resolveSegmentSpeakerName(segment, speakerMappings);
  if (resolved) return resolved;
  if (segment.source === "mic" || segment.speaker === "you") return selfLabel;
  if (segment.speaker) {
    const num = Number.parseInt(segment.speaker.replace("speaker_", ""), 10);
    if (!Number.isNaN(num)) return t("notes.speaker.label", { n: num + 1 });
  }
  return t("notes.speaker.them");
}

export function buildLlmTranscript(
  segments: TranscriptSegment[],
  speakerMappings: Record<string, string>,
  selfLabel: string,
  t: Translate
): string {
  return segments
    .map((s) => `${resolveLlmSpeakerLabel(s, speakerMappings, selfLabel, t)}: ${s.text}`)
    .join("\n");
}

const formatPerson = (name: string | null, email: string | null): string => {
  const trimmedName = name?.trim() || "";
  const trimmedEmail = email?.trim() || "";
  if (trimmedName && trimmedEmail) return `${trimmedName} <${trimmedEmail}>`;
  return trimmedName || trimmedEmail;
};

/**
 * Context block prepended to the LLM payload so note generation knows who the
 * note owner is (instead of guessing an identity from names spoken in the
 * transcript) and who was invited.
 */
export function buildMeetingContext(identity: MeetingIdentity, selfLabel: string): string {
  const lines: string[] = [];
  const self = formatPerson(identity.selfName, identity.selfEmail);
  if (self) {
    lines.push(`The user taking these notes ("${selfLabel}" in the transcript) is ${self}.`);
  }
  const invited = identity.participants
    .filter((p) => !isSelfParticipant(p, identity))
    .map((p) => formatPerson(p.displayName, p.email))
    .filter(Boolean);
  if (invited.length > 0) lines.push(`Invited participants: ${invited.join(", ")}.`);
  return lines.length > 0 ? `## Meeting Context\n${lines.join("\n")}` : "";
}

/**
 * Everyone we can name around a note — the note owner, calendar participants,
 * mapped speaker clusters, and named segments. Same-name attendees with
 * different emails stay distinct so tagging can detect ambiguous owners.
 * Feeds the editor's @mention suggestions and action-item owner tagging.
 */
export function collectKnownPeople(
  identity: MeetingIdentity,
  speakerMappings: Record<string, string>,
  segments: TranscriptSegment[]
): MentionPerson[] {
  const people: MentionPerson[] = [];
  const byName = new Map<string, MentionPerson[]>();
  const push = (name: string | null | undefined, email: string | null | undefined) => {
    const trimmed = name?.trim();
    if (!trimmed) return;
    const key = trimmed.replace(/\s+/g, " ").toLowerCase();
    const address = email?.trim() || null;
    const existing = byName.get(key) ?? [];
    if (existing.length > 0) {
      if (!address || existing.some((p) => p.email?.toLowerCase() === address.toLowerCase()))
        return;
    }
    const person = { name: trimmed, email: address };
    existing.push(person);
    byName.set(key, existing);
    people.push(person);
  };

  push(identity.selfName, identity.selfEmail);
  for (const p of identity.participants) {
    if (isSelfParticipant(p, identity)) continue;
    push(p.displayName || p.email.split("@")[0], p.email);
  }
  for (const name of Object.values(speakerMappings)) push(name, null);
  for (const segment of segments) push(segment.speakerName, null);
  return people;
}
