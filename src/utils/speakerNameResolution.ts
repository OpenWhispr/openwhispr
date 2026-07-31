import type { TranscriptSegment } from "../stores/meetingRecordingStore";
// Explicit extension so this module also resolves under plain node (tests).
import { isTranscriptSpeakerLocked, lockTranscriptSpeaker } from "./transcriptSpeakerState.ts";

export type SpeakerNameSource = "lock" | "mapping" | "segment";

export interface ResolvedSpeakerName {
  name: string | null;
  source: SpeakerNameSource | null;
}

export type SpeakerMappings = Record<string, string>;

const NO_NAME: ResolvedSpeakerName = { name: null, source: null };

const segmentOwnName = (segment: TranscriptSegment) =>
  segment.speakerName && !segment.speakerIsPlaceholder ? segment.speakerName : null;

/**
 * A name the user set on a specific segment outranks the note-level cluster
 * mapping. Without that ordering, relabelling a cluster permanently hides every
 * per-segment assignment inside it, so further corrections look like no-ops.
 */
export const resolveSegmentSpeakerName = (
  segment: TranscriptSegment,
  speakerMappings?: SpeakerMappings
): ResolvedSpeakerName => {
  const ownName = segmentOwnName(segment);
  if (ownName && isTranscriptSpeakerLocked(segment)) {
    return { name: ownName, source: "lock" };
  }

  const mapped = segment.speaker ? speakerMappings?.[segment.speaker] : undefined;
  if (mapped) return { name: mapped, source: "mapping" };

  if (ownName) return { name: ownName, source: "segment" };

  return NO_NAME;
};

export const getSpeakerDisplayNumber = (speakerId: string) => {
  const match = speakerId.match(/speaker_(\d+)/);
  return match ? Number(match[1]) + 1 : 1;
};

const sameName = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** Cluster id whose resolved name already matches `displayName`, if any. */
export const findClusterForName = (
  segments: TranscriptSegment[],
  displayName: string,
  speakerMappings?: SpeakerMappings
): string | null => {
  for (const segment of segments) {
    if (!segment.speaker || segment.speaker === "you") continue;
    if (sameName(resolveSegmentSpeakerName(segment, speakerMappings).name, displayName)) {
      return segment.speaker;
    }
  }
  return null;
};

/**
 * The name a cluster currently answers to, if any. Once a cluster has one, picking
 * a different name on a single line must not rename everybody in it.
 */
export const resolveClusterName = (
  segments: TranscriptSegment[],
  speakerId: string,
  speakerMappings?: SpeakerMappings
): string | null => {
  const mapped = speakerMappings?.[speakerId];
  if (mapped) return mapped;

  for (const segment of segments) {
    if (segment.speaker !== speakerId) continue;
    const { name } = resolveSegmentSpeakerName(segment, speakerMappings);
    if (name) return name;
  }
  return null;
};

const nextSpeakerClusterId = (segments: TranscriptSegment[], speakerMappings?: SpeakerMappings) => {
  let max = -1;
  const consider = (speakerId?: string) => {
    const match = speakerId?.match(/^speaker_(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  };
  for (const segment of segments) consider(segment.speaker);
  for (const speakerId of Object.keys(speakerMappings || {})) consider(speakerId);
  return `speaker_${max + 1}`;
};

export interface SpeakerAssignmentResult {
  segments: TranscriptSegment[];
  speakerId: string;
  /** True when the selection was moved out of the cluster it used to belong to. */
  didSplit: boolean;
}

/**
 * Assigns `displayName` to the selected segments, moving them into their own
 * speaker cluster when they are only part of one. Keeping the selection inside a
 * shared cluster would let a later cluster-wide relabel overwrite it.
 */
export const assignSegmentsToSpeaker = (
  segments: TranscriptSegment[],
  selectedIds: Iterable<string>,
  displayName: string,
  options: { speakerMappings?: SpeakerMappings; profileId?: number } = {}
): SpeakerAssignmentResult => {
  const { speakerMappings, profileId } = options;
  const selected = new Set(selectedIds);
  const selectedSegments = segments.filter((segment) => selected.has(segment.id));

  if (selectedSegments.length === 0) {
    return { segments, speakerId: "", didSplit: false };
  }

  const sourceClusters = new Set(
    selectedSegments.map((segment) => segment.speaker).filter(Boolean) as string[]
  );
  const existingCluster = findClusterForName(segments, displayName, speakerMappings);

  // A cluster the selection wholly covers can simply be renamed in place.
  const wholeClusterSelected =
    sourceClusters.size === 1 &&
    !existingCluster &&
    segments.every(
      (segment) => segment.speaker !== [...sourceClusters][0] || selected.has(segment.id)
    );

  const targetSpeakerId =
    existingCluster ||
    (wholeClusterSelected
      ? [...sourceClusters][0]
      : nextSpeakerClusterId(segments, speakerMappings));

  const nextSegments = segments.map((segment) =>
    selected.has(segment.id)
      ? lockTranscriptSpeaker(segment, {
          speaker: targetSpeakerId,
          speakerName: displayName,
          speakerIsPlaceholder: false,
          suggestedName: undefined,
          suggestedProfileId: profileId ?? undefined,
        })
      : segment
  );

  return {
    segments: nextSegments,
    speakerId: targetSpeakerId,
    didSplit: !wholeClusterSelected,
  };
};
