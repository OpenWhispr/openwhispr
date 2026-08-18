import type { TranscriptSegment } from "./meetingRecordingStore";
import { normalizeTranscriptSegment } from "../utils/transcriptSpeakerState";

/**
 * State transition for live meeting segment events (partial / final / retract)
 * that never mutates its state argument; all side effects are confined to the
 * injected deps. Extracted from meetingRecordingStore's
 * onMeetingTranscriptionSegment handler; speaker identity side effects stay in
 * the store and are driven by the returned reduction. Phase 0: byte-for-byte
 * today's semantics.
 */
export interface MeetingSegmentEvent {
  text: string;
  source: "mic" | "system";
  type: "partial" | "final" | "retract";
  timestamp?: number;
}

export interface MeetingSegmentState {
  segments: TranscriptSegment[];
  micPartial: string;
  systemPartial: string;
}

export interface MeetingSegmentReducerDeps {
  /** Renderer-side id for a new final (today `seg-${++segmentCounter}`). */
  mintSegmentId: () => string;
  /** Applies speaker identifications, provisional speaker, index reservation, locks. Must be free of store writes — the reducer inserts into the segments snapshot it was handed. */
  decorateFinal: (segment: TranscriptSegment) => TranscriptSegment;
}

export type MeetingSegmentReduction =
  | { kind: "retract"; state: MeetingSegmentState; removed: TranscriptSegment[] }
  | { kind: "partial"; state: MeetingSegmentState; source: "mic" | "system" }
  | { kind: "final"; state: MeetingSegmentState; inserted: TranscriptSegment; index: number };

// Live finals are inserted by capture timestamp. An incoming final without a
// timestamp goes to the end (`?? Infinity`); an existing row without one sorts
// as 0. Strict `>` keeps equal timestamps in arrival order.
export function insertSegmentByTimestamp(
  segments: TranscriptSegment[],
  seg: TranscriptSegment
): { segments: TranscriptSegment[]; index: number } {
  const ts = seg.timestamp ?? Infinity;
  let i = segments.length;
  while (i > 0 && (segments[i - 1].timestamp ?? 0) > ts) i--;
  const next =
    i === segments.length
      ? [...segments, seg]
      : [...segments.slice(0, i), seg, ...segments.slice(i)];
  return { segments: next, index: i };
}

export function reduceMeetingSegmentEvent(
  state: MeetingSegmentState,
  event: MeetingSegmentEvent,
  deps: MeetingSegmentReducerDeps
): MeetingSegmentReduction {
  if (event.type === "retract") {
    const removed: TranscriptSegment[] = [];
    const segments = state.segments.filter((seg) => {
      const hit =
        seg.source === event.source && seg.timestamp === event.timestamp && seg.text === event.text;
      if (hit) removed.push(seg);
      return !hit;
    });
    return { kind: "retract", state: { ...state, segments }, removed };
  }

  if (event.type === "partial") {
    const patch =
      event.source === "mic" ? { micPartial: event.text } : { systemPartial: event.text };
    return { kind: "partial", source: event.source, state: { ...state, ...patch } };
  }

  const raw = normalizeTranscriptSegment({
    id: deps.mintSegmentId(),
    text: event.text,
    source: event.source,
    timestamp: event.timestamp,
  });
  const inserted = deps.decorateFinal(raw);
  const { segments, index } = insertSegmentByTimestamp(state.segments, inserted);
  const partialPatch = event.source === "mic" ? { micPartial: "" } : { systemPartial: "" };
  return { kind: "final", inserted, index, state: { ...state, segments, ...partialPatch } };
}
