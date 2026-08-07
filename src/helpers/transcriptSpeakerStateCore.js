const SPEAKER_STATE_FIELDS = [
  "speaker",
  "speakerName",
  "speakerIsPlaceholder",
  "suggestedName",
  "suggestedProfileId",
  "speakerStatus",
  "speakerLocked",
  "speakerLockSource",
];

const normalizeText = (text) =>
  String(text || "")
    .trim()
    .replace(/\s+/g, " ");

const getSegmentMatchKey = (segment) =>
  [segment.source, segment.timestamp ?? "", normalizeText(segment.text)].join("|");

const canonicalizeTranscriptSpeakerStatus = (status, speakerLocked, speakerLockSource) => {
  if (speakerLocked || speakerLockSource === "user") return "locked";

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

const pickSpeakerStatus = (segment) => {
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

const isTranscriptSpeakerLocked = (segment) =>
  !!segment.speakerLocked ||
  segment.speakerLockSource === "user" ||
  canonicalizeTranscriptSpeakerStatus(segment.speakerStatus) === "locked";

const normalizeTranscriptSegment = (segment) => {
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

const normalizeTranscriptSegments = (segments) => segments.map(normalizeTranscriptSegment);

const mergeSpeakerFields = (existing, incoming) => {
  const merged = { ...incoming };

  for (const field of SPEAKER_STATE_FIELDS) {
    if (merged[field] === undefined && existing[field] !== undefined) {
      merged[field] = existing[field];
    }
  }

  if (isTranscriptSpeakerLocked(existing)) {
    // Keep the user's name/lock but let diarization refine the speaker cluster,
    // so one locked label cannot freeze a bucket that diarization later splits.
    for (const field of SPEAKER_STATE_FIELDS) {
      if (field === "speaker" || field === "speakerIsPlaceholder") continue;
      if (existing[field] !== undefined) merged[field] = existing[field];
    }
  }

  return normalizeTranscriptSegment(merged);
};

const mergeTranscriptSegments = (existingSegments, incomingSegments) => {
  if (incomingSegments.length === 0) return normalizeTranscriptSegments(existingSegments);
  if (existingSegments.length === 0) {
    return incomingSegments.map((segment, index) =>
      normalizeTranscriptSegment({ ...segment, id: segment.id || `merged-${index}` })
    );
  }

  const existingById = new Map();
  const existingByKey = new Map();
  existingSegments.forEach((segment, index) => {
    if (segment.id) existingById.set(segment.id, index);
    const key = getSegmentMatchKey(segment);
    const bucket = existingByKey.get(key);
    if (bucket) bucket.push(index);
    else existingByKey.set(key, [index]);
  });

  const usedIndexes = new Set();
  const enrichedByIndex = new Map();
  const unmatchedIncoming = [];

  incomingSegments.forEach((segment, index) => {
    const findUnused = (candidates) =>
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

const serializeTranscriptSegments = (segments) =>
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

module.exports = {
  canonicalizeTranscriptSpeakerStatus,
  isTranscriptSpeakerLocked,
  mergeTranscriptSegments,
  normalizeTranscriptSegment,
  normalizeTranscriptSegments,
  serializeTranscriptSegments,
};
