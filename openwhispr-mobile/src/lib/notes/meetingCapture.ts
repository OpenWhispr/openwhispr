/**
 * Pure decisions for a cloud meeting's recording state, kept out of `useCloudMeeting`
 * so they can be unit-tested without React.
 */
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';

export type CloudMeetingStatus = 'connecting' | 'live' | 'reconnecting' | 'interrupted' | 'error';

/**
 * A stopped microphone outranks a reconnecting socket: audio the mic never heard is
 * lost for good, while audio held during a reconnect is still sent once it returns.
 */
export function deriveCloudMeetingStatus(input: {
  started: boolean;
  failed: boolean;
  capturing: boolean;
  reconnecting: boolean;
}): CloudMeetingStatus {
  if (input.failed) return 'error';
  if (!input.started) return 'connecting';
  if (!input.capturing) return 'interrupted';
  if (input.reconnecting) return 'reconnecting';
  return 'live';
}

// Frames arrive every ~100 ms, so five seconds without growth means the mic has
// stopped even if the native module never said so.
export const CAPTURE_STALL_MS = 5000;

/** True when the captured clock has not advanced for CAPTURE_STALL_MS. */
export function isCaptureStalled(lastGrowthAtMs: number, nowMs: number): boolean {
  return nowMs - lastGrowthAtMs >= CAPTURE_STALL_MS;
}

/** When the captured clock last grew, and to what. */
export interface CaptureClock {
  lastCapturedMs: number;
  lastGrowthAtMs: number;
}

/** Everything `useCloudMeeting` tracks for one recording. */
export interface CloudMeetingSessionState {
  started: boolean;
  failed: boolean;
  capturing: boolean;
  stalled: boolean;
  reconnecting: boolean;
  error: string | null;
  partialText: string;
  utterances: RealtimeUtterance[];
  elapsedSeconds: number;
  capturedSeconds: number;
  droppedSeconds: number;
  interruptions: number;
  reconnects: number;
  utteranceCount: number;
  clock: CaptureClock;
}

/**
 * The state a recording starts from. The hook can be turned on again in the same mount
 * (Stop that fails returns to the prompt), and each new session's captured clock and
 * utterance indices start at zero, so nothing may carry over from the last one.
 */
export function initialCloudMeetingSession(nowMs: number): CloudMeetingSessionState {
  return {
    started: false,
    failed: false,
    capturing: true,
    stalled: false,
    reconnecting: false,
    error: null,
    partialText: '',
    utterances: [],
    elapsedSeconds: 0,
    capturedSeconds: 0,
    droppedSeconds: 0,
    interruptions: 0,
    reconnects: 0,
    utteranceCount: 0,
    clock: { lastCapturedMs: 0, lastGrowthAtMs: nowMs },
  };
}

/** Advance the capture clock with a new reading and say whether capture has stalled. */
export function trackCaptureGrowth(
  clock: CaptureClock,
  capturedMs: number,
  nowMs: number,
): { clock: CaptureClock; stalled: boolean } {
  const next =
    capturedMs > clock.lastCapturedMs
      ? { lastCapturedMs: capturedMs, lastGrowthAtMs: nowMs }
      : clock;
  return { clock: next, stalled: isCaptureStalled(next.lastGrowthAtMs, nowMs) };
}
