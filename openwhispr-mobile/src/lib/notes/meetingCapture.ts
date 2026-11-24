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

/**
 * Whether the screen and lock screen should read as recording. A reconnect still captures
 * audio and sends it once the socket returns, and a session still connecting hasn't lost
 * anything yet; only a stopped mic or an ended session has.
 */
export function isCloudMeetingCapturing(status: CloudMeetingStatus): boolean {
  return status !== 'interrupted' && status !== 'error';
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

// Short gaps (a reconnect, a brief Siri prompt) aren't worth an alert; half a minute is.
export const PARTIAL_CAPTURE_THRESHOLD_SECONDS = 30;

/** How much of a meeting's wall-clock time actually reached the recording. */
export interface CaptureCoverage {
  recordedSeconds: number;
  elapsedSeconds: number;
  missingSeconds: number;
  isPartial: boolean;
}

/** `recordedMs` is captured minus dropped audio; partial when 30 s or more is missing. */
export function captureCoverage(recordedMs: number, elapsedMs: number): CaptureCoverage {
  const recordedSeconds = Math.max(0, Math.floor(recordedMs / 1000));
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const missingSeconds = Math.max(0, elapsedSeconds - recordedSeconds);
  return {
    recordedSeconds,
    elapsedSeconds,
    missingSeconds,
    isPartial: missingSeconds >= PARTIAL_CAPTURE_THRESHOLD_SECONDS,
  };
}

export const PARTIAL_CAPTURE_TITLE = "Part of this meeting wasn't recorded";

// Recorded rounds down and elapsed rounds up: with 30 s or more missing, rounding both the
// same way could print "30 min of this 30 min meeting".
const formatRecordedMinutes = (seconds: number): string =>
  seconds < 60 ? 'under 1 min' : `${Math.floor(seconds / 60)} min`;

const formatElapsedMinutes = (seconds: number): string =>
  `${Math.max(1, Math.ceil(seconds / 60))} min`;

export function partialCaptureMessage(coverage: CaptureCoverage): string {
  return `OpenWhispr recorded ${formatRecordedMinutes(coverage.recordedSeconds)} of this ${formatElapsedMinutes(coverage.elapsedSeconds)} meeting. The rest was missed while the microphone or the connection was interrupted.`;
}
