import type { NewSegment, NewSpeaker, Segment, Speaker } from '@/data/types';

/**
 * Bridges the desktop transcript format (a denormalized JSON array stored in
 * notes.transcript) and mobile's normalized transcript_segments + speakers
 * tables. Desktop is the origin of the wire format; see
 * openwhispr/src/utils/transcriptSpeakerState.ts serializeTranscriptSegments.
 *
 * Pure functions only — no DB or network — mirroring cloudMeetingSegments.ts.
 */

/** Synthetic speaker label for desktop `source: 'mic'` lines with no explicit speaker. */
export const MIC_SPEAKER_LABEL = '__mic__';

export type ParsedSegment = Omit<NewSegment, 'noteId'>;
export type ParsedSpeaker = Omit<NewSpeaker, 'noteId'>;

export interface ParsedTranscript {
  segments: ParsedSegment[];
  speakers: ParsedSpeaker[];
}

type DesktopSegment = {
  text?: unknown;
  source?: unknown;
  timestamp?: unknown;
  speaker?: unknown;
  speakerName?: unknown;
  speakerStatus?: unknown;
  speakerLocked?: unknown;
  speakerLockSource?: unknown;
};

const SPEAKER_STATUSES = new Set(['provisional', 'suggested', 'confirmed', 'locked']);
const LOCK_SOURCES = new Set(['user', 'diarization', 'suggestion']);

const asSpeakerStatus = (value: unknown): Speaker['speakerStatus'] =>
  typeof value === 'string' && SPEAKER_STATUSES.has(value)
    ? (value as Speaker['speakerStatus'])
    : null;

const asLockSource = (value: unknown): Speaker['speakerLockSource'] =>
  typeof value === 'string' && LOCK_SOURCES.has(value)
    ? (value as Speaker['speakerLockSource'])
    : null;

const labelFor = (item: DesktopSegment): string | null => {
  if (typeof item.speaker === 'string' && item.speaker) return item.speaker;
  if (item.source === 'mic') return MIC_SPEAKER_LABEL;
  return null;
};

/**
 * Decomposes a desktop transcript JSON string into mobile segment + speaker
 * rows (minus noteId, injected at write time). Returns null for malformed or
 * non-array input so callers can leave local data untouched.
 *
 * Timestamps are desktop ms-epoch; mobile stores offsets, so they are rebased
 * to the earliest timestamp. Missing timestamps degrade to a monotonic fallback
 * — cosmetic only, since display order is sortOrder-first.
 */
export function parseRemoteTranscript(raw: string): ParsedTranscript | null {
  if (typeof raw !== 'string' || !raw.startsWith('[')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  // Every member must be a non-null object; a stray primitive (e.g. [null], [1])
  // would otherwise throw mid-parse and abort the whole pull. Treat as malformed.
  if (parsed.some((item) => typeof item !== 'object' || item === null)) return null;

  const items = parsed as DesktopSegment[];
  const timestamps = items
    .map((item) => (typeof item.timestamp === 'number' ? item.timestamp : null))
    .filter((value): value is number => value !== null);
  const minTs = timestamps.length ? Math.min(...timestamps) : 0;

  const speakerOrder: string[] = [];
  const speakerByLabel = new Map<string, ParsedSpeaker>();
  const segments: ParsedSegment[] = [];
  let prevStart = 0;

  items.forEach((item, index) => {
    const label = labelFor(item);
    const startMs =
      typeof item.timestamp === 'number'
        ? Math.max(0, Math.round(item.timestamp - minTs))
        : prevStart;
    prevStart = startMs;

    segments.push({
      text: typeof item.text === 'string' ? item.text : '',
      startMs,
      endMs: startMs, // patched to next segment's start below
      speakerLabel: label,
      sortOrder: index,
    });

    if (label && !speakerByLabel.has(label)) {
      const explicitName =
        typeof item.speakerName === 'string' && item.speakerName ? item.speakerName : null;
      speakerOrder.push(label);
      speakerByLabel.set(label, {
        speakerLabel: label,
        displayName: label === MIC_SPEAKER_LABEL ? (explicitName ?? 'You') : explicitName,
        speakerStatus: asSpeakerStatus(item.speakerStatus),
        speakerLocked: item.speakerLocked === true ? 1 : 0,
        speakerLockSource: asLockSource(item.speakerLockSource),
        sortOrder: speakerOrder.length - 1,
      });
    }
  });

  for (let i = 0; i < segments.length; i += 1) {
    const nextStart = i + 1 < segments.length ? segments[i + 1].startMs : segments[i].startMs;
    segments[i].endMs = Math.max(segments[i].startMs, nextStart);
  }

  return { segments, speakers: speakerOrder.map((label) => speakerByLabel.get(label)!) };
}

/**
 * Serializes local segments + speakers into the desktop transcript JSON shape
 * for push. Existing desktop lines retain their original metadata. New mobile
 * lines omit timestamps because offsets are not desktop epoch timestamps.
 */
export function serializeSegmentsForSync(
  segments: Segment[],
  speakers: Speaker[],
  originalRaw?: string | null,
): string {
  const original = originalRaw ? parseRemoteTranscript(originalRaw) : null;
  const originalItems: Record<string, unknown>[] =
    original && originalRaw ? JSON.parse(originalRaw) : [];
  const originalSpeakers = new Map(
    original?.speakers.map((speaker) => [speaker.speakerLabel, speaker]),
  );
  const speakerByLabel = new Map<string, Speaker>();
  for (const speaker of speakers) {
    if (speaker.speakerLabel) speakerByLabel.set(speaker.speakerLabel, speaker);
  }

  const ordered = [...segments].sort((a, b) =>
    a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.startMs - b.startMs,
  );

  const items = ordered.map((segment) => {
    const isMic = !segment.speakerLabel || segment.speakerLabel === MIC_SPEAKER_LABEL;
    const speaker = segment.speakerLabel ? speakerByLabel.get(segment.speakerLabel) : undefined;
    const originalSegment = original?.segments[segment.sortOrder];
    const originalItem =
      originalSegment?.text === segment.text ? originalItems[segment.sortOrder] : undefined;
    if (originalItem) {
      // Preserve each desktop line, including fields mobile cannot interpret.
      // A speaker edit applies its complete state to every affected line.
      const item = { ...originalItem };
      const labelChanged = segment.speakerLabel !== originalSegment?.speakerLabel;
      if (labelChanged) {
        item.source = isMic ? 'mic' : 'system';
        if (isMic) delete item.speaker;
        else item.speaker = segment.speakerLabel;
      }
      const previousSpeaker = segment.speakerLabel
        ? originalSpeakers.get(segment.speakerLabel)
        : undefined;
      if (speaker) {
        const fields = [
          ['displayName', 'speakerName'],
          ['speakerStatus', 'speakerStatus'],
          ['speakerLocked', 'speakerLocked'],
          ['speakerLockSource', 'speakerLockSource'],
        ] as const;
        const speakerChanged = fields.some(
          ([localKey]) => speaker[localKey] !== previousSpeaker?.[localKey],
        );
        if (labelChanged || speakerChanged) {
          delete item.suggestedName;
          delete item.suggestedProfileId;
          for (const [localKey, wireKey] of fields) {
            const value = speaker[localKey];
            if (value == null) delete item[wireKey];
            else item[wireKey] = localKey === 'speakerLocked' ? Boolean(value) : value;
          }
        }
      }
      return item;
    }
    const item: Record<string, unknown> = {
      text: segment.text,
      source: isMic ? 'mic' : 'system',
    };

    if (!isMic) {
      item.speaker = segment.speakerLabel;
      if (speaker?.displayName) item.speakerName = speaker.displayName;
      if (speaker?.speakerStatus) item.speakerStatus = speaker.speakerStatus;
      if (speaker?.speakerLocked) item.speakerLocked = true;
      if (speaker?.speakerLockSource) item.speakerLockSource = speaker.speakerLockSource;
    }

    return item;
  });

  return JSON.stringify(items);
}
