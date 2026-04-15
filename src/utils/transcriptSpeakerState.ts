import type { TranscriptSegment } from "../hooks/useMeetingTranscription";

export type TranscriptSpeakerStatus = "provisional" | "confirmed" | "suggested" | "locked";
export type TranscriptSpeakerLockSource = "user" | "diarization" | "suggestion";

const SPEAKER_STATE_FIELDS = [
  "speaker",
  "speakerName",
  "speakerIsPlaceholder",
  "suggestedName",
  "suggestedProfileId",
  "speakerStatus",
  "speakerLocked",
  "speakerLockSource",
] as const;

type SpeakerStateField = (typeof SPEAKER_STATE_FIELDS)[number];

const normalizeText = (text: string) => text.trim().replace(/\s+/g, " ");

const getSegmentMatchKey = (segment: TranscriptSegment) =>
  [segment.source, segment.timestamp ?? "", normalizeText(segment.text)].join("|");

const canonicalizeTranscriptSpeakerStatus = (
  status?: string,
  speakerLocked?: boolean,
  speakerLockSource?: TranscriptSpeakerLockSource
): TranscriptSpeakerStatus | undefined => {
  if (speakerLocked || speakerLockSource === "user") {
    return "locked";
  }

  switch (status) {
    case "provisional":
    case "confirmed":
    case "suggested":
    case "locked":
      return status;
    case "suggested_profile":
      return "suggested";
    case "user_locked":
      return "locked";
    case "uncertain_overlap":
      return "provisional";
    default:
      return undefined;
  }
};

const pickSpeakerStatus = (segment: TranscriptSegment): TranscriptSpeakerStatus | undefined => {
  const normalizedStatus = canonicalizeTranscriptSpeakerStatus(
    segment.speakerStatus,
    segment.speakerLocked,
    segment.speakerLockSource
  );
  if (normalizedStatus) return normalizedStatus;
  if (segment.suggestedName && !segment.speakerName) return "suggested";
  if (segment.source === "system" && segment.speakerIsPlaceholder) return "provisional";
  if (segment.speaker && segment.speaker !== "you") return "confirmed";
  return undefined;
};

export const isTranscriptSpeakerLocked = (segment: TranscriptSegment) =>
  !!segment.speakerLocked ||
  segment.speakerLockSource === "user" ||
  canonicalizeTranscriptSpeakerStatus(segment.speakerStatus) === "locked";

export const normalizeTranscriptSegment = (segment: TranscriptSegment): TranscriptSegment => {
  const speakerStatus = pickSpeakerStatus(segment);
  const speakerLocked =
    !!segment.speakerLocked || segment.speakerLockSource === "user" || speakerStatus === "locked";
  return {
    ...segment,
    speakerStatus,
    speakerLocked,
    speakerLockSource: speakerLocked
      ? (segment.speakerLockSource ?? "user")
      : segment.speakerLockSource,
  };
};

export const normalizeTranscriptSegments = (segments: TranscriptSegment[]) =>
  segments.map((segment) => normalizeTranscriptSegment(segment));

export const applyTranscriptSpeakerPatch = (
  segment: TranscriptSegment,
  patch: Partial<Pick<TranscriptSegment, SpeakerStateField>>
) => normalizeTranscriptSegment({ ...segment, ...patch });

export const lockTranscriptSpeaker = (
  segment: TranscriptSegment,
  patch: Partial<Pick<TranscriptSegment, SpeakerStateField>> = {}
) =>
  normalizeTranscriptSegment({
    ...segment,
    ...patch,
    speakerLocked: true,
    speakerStatus: "locked",
    speakerLockSource: "user",
  });

const mergeSpeakerFields = (existing: TranscriptSegment, incoming: TranscriptSegment) => {
  const merged = { ...incoming } as TranscriptSegment;
  const existingFields = existing as Record<SpeakerStateField, unknown>;
  const mergedFields = merged as Record<SpeakerStateField, unknown>;

  for (const field of SPEAKER_STATE_FIELDS) {
    if (mergedFields[field] === undefined && existingFields[field] !== undefined) {
      mergedFields[field] = existingFields[field];
    }
  }

  if (isTranscriptSpeakerLocked(existing)) {
    for (const field of SPEAKER_STATE_FIELDS) {
      if (existingFields[field] !== undefined) {
        mergedFields[field] = existingFields[field];
      }
    }
  }

  return normalizeTranscriptSegment(merged);
};

export const mergeTranscriptSegments = (
  existingSegments: TranscriptSegment[],
  incomingSegments: TranscriptSegment[]
) => {
  if (incomingSegments.length === 0) {
    return normalizeTranscriptSegments(existingSegments);
  }
  if (existingSegments.length === 0) {
    return incomingSegments.map((segment, index) =>
      normalizeTranscriptSegment({ ...segment, id: segment.id || `merged-${index}` })
    );
  }

  const existingById = new Map<string, number>();
  const existingByKey = new Map<string, number[]>();

  existingSegments.forEach((segment, index) => {
    if (segment.id) existingById.set(segment.id, index);
    const key = getSegmentMatchKey(segment);
    const bucket = existingByKey.get(key);
    if (bucket) bucket.push(index);
    else existingByKey.set(key, [index]);
  });

  const usedIndexes = new Set<number>();
  const enrichedByIndex = new Map<number, TranscriptSegment>();
  const unmatchedIncoming: TranscriptSegment[] = [];

  incomingSegments.forEach((segment, index) => {
    const findUnused = (candidates?: number[]) =>
      candidates?.find((candidateIndex) => !usedIndexes.has(candidateIndex));

    let matchIndex = segment.id ? existingById.get(segment.id) : undefined;
    if (matchIndex !== undefined && usedIndexes.has(matchIndex)) matchIndex = undefined;

    if (matchIndex === undefined) {
      matchIndex = findUnused(existingByKey.get(getSegmentMatchKey(segment)));
    }

    if (matchIndex === undefined) {
      const fallbackIndex = existingSegments.findIndex(
        (candidate, existingIndex) =>
          !usedIndexes.has(existingIndex) &&
          candidate.source === segment.source &&
          candidate.text === segment.text
      );
      if (fallbackIndex >= 0) matchIndex = fallbackIndex;
    }

    if (matchIndex !== undefined) {
      usedIndexes.add(matchIndex);
      enrichedByIndex.set(matchIndex, mergeSpeakerFields(existingSegments[matchIndex], segment));
    } else {
      unmatchedIncoming.push(
        normalizeTranscriptSegment({ ...segment, id: segment.id || `merged-${index}` })
      );
    }
  });

  const preserved = existingSegments.map(
    (segment, index) => enrichedByIndex.get(index) ?? normalizeTranscriptSegment(segment)
  );

  return [...preserved, ...unmatchedIncoming];
};

export const serializeTranscriptSegments = (segments: TranscriptSegment[]) =>
  JSON.stringify(
    segments.map((segment) => ({
      text: segment.text,
      source: segment.source,
      timestamp: segment.timestamp,
      speaker: segment.speaker,
      speakerName: segment.speakerName,
      speakerIsPlaceholder: segment.speakerIsPlaceholder,
      suggestedName: segment.suggestedName,
      suggestedProfileId: segment.suggestedProfileId,
      speakerStatus: segment.speakerStatus,
      speakerLocked: segment.speakerLocked,
      speakerLockSource: segment.speakerLockSource,
    }))
  );
