import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import {
  isTranscriptSpeakerLocked as isTranscriptSpeakerLockedCore,
  mergeTranscriptSegments as mergeTranscriptSegmentsCore,
  normalizeTranscriptSegment as normalizeTranscriptSegmentCore,
  normalizeTranscriptSegments as normalizeTranscriptSegmentsCore,
  serializeTranscriptSegments as serializeTranscriptSegmentsCore,
} from "../helpers/transcriptSpeakerStateCore";

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

export const isTranscriptSpeakerLocked = (segment: TranscriptSegment): boolean =>
  isTranscriptSpeakerLockedCore(segment);

export const normalizeTranscriptSegment = (segment: TranscriptSegment): TranscriptSegment =>
  normalizeTranscriptSegmentCore(segment);

export const normalizeTranscriptSegments = (segments: TranscriptSegment[]): TranscriptSegment[] =>
  normalizeTranscriptSegmentsCore(segments);

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

export const mergeTranscriptSegments = (
  existingSegments: TranscriptSegment[],
  incomingSegments: TranscriptSegment[]
) => mergeTranscriptSegmentsCore(existingSegments, incomingSegments) as TranscriptSegment[];

export const serializeTranscriptSegments = (segments: TranscriptSegment[]) =>
  serializeTranscriptSegmentsCore(segments);
