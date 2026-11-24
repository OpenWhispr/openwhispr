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
  /**
   * Whether the first socket has been accepted. A recorded meeting starts capturing before
   * any socket exists, so it isn't live until then. Absent means connected: a session without
   * a recording only starts once its first socket is open.
   */
  connected?: boolean;
}): CloudMeetingStatus {
  if (input.failed) return 'error';
  if (!input.started) return 'connecting';
  if (!input.capturing) return 'interrupted';
  if (input.reconnecting) return 'reconnecting';
  if (input.connected === false) return 'connecting';
  return 'live';
}

/**
 * Whether the screen shows the recording dot. A recorded meeting that is still connecting is
 * already writing its audio to the file, so it reads as recording once capture has started.
 */
export function isCloudMeetingRecordingAudio(
  status: CloudMeetingStatus,
  captureStarted: boolean,
): boolean {
  if (status === 'connecting') return captureStarted;
  return status === 'live' || status === 'reconnecting';
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

export const OWED_CAPTURE_TITLE = "Part of this meeting isn't transcribed yet";

/** For a meeting whose recording still holds audio the transcript is waiting for. */
export function owedCaptureMessage(coverage: CaptureCoverage): string {
  return `OpenWhispr has transcribed ${formatRecordedMinutes(coverage.recordedSeconds)} of this ${formatElapsedMinutes(coverage.elapsedSeconds)} meeting so far. Audio still saved on this device is transcribed the next time OpenWhispr is open with a connection.`;
}

const MIC_MISSED_SENTENCE = 'The rest was missed while the microphone was interrupted.';

export const UNTRANSCRIBED_CAPTURE_TITLE = "Part of this meeting wasn't transcribed";

export interface MeetingCaptureAlertInput {
  /** From when capture began. */
  elapsedMs: number;
  /** Audio the microphone delivered. */
  capturedMs: number;
  /** Captured audio the stream dropped with no recording to take it from. */
  missedMs: number;
  /** Recorded audio saved to be transcribed later. */
  owedMs: number;
  /** Recorded audio the transcript misses whose list of owed audio could not be saved. */
  unsavedMs?: number;
}

/**
 * The alert for a cloud meeting that ended with part of it missing from the note, or null.
 * Owed audio is promised only when it was saved, and never stands in for audio the microphone
 * didn't record. Audio recorded but never to be transcribed counts as recorded and says so.
 */
export function meetingCaptureAlert(
  input: MeetingCaptureAlertInput,
): { title: string; message: string } | null {
  const unsavedMs = Math.max(0, input.unsavedMs ?? 0);
  const kept = captureCoverage(input.capturedMs - input.missedMs, input.elapsedMs);
  if (input.owedMs <= 0 && unsavedMs <= 0) {
    return kept.isPartial
      ? { title: PARTIAL_CAPTURE_TITLE, message: partialCaptureMessage(kept) }
      : null;
  }
  if (unsavedMs <= 0 && !kept.isPartial) {
    const transcribed = captureCoverage(
      input.capturedMs - input.missedMs - input.owedMs,
      input.elapsedMs,
    );
    return transcribed.isPartial
      ? { title: OWED_CAPTURE_TITLE, message: owedCaptureMessage(transcribed) }
      : null;
  }
  const lacking = captureCoverage(
    input.capturedMs - input.missedMs - input.owedMs - unsavedMs,
    input.elapsedMs,
  );
  if (!lacking.isPartial) return null;
  const sentences = kept.isPartial
    ? [
        `OpenWhispr recorded ${formatRecordedMinutes(kept.recordedSeconds)} of this ${formatElapsedMinutes(kept.elapsedSeconds)} meeting.`,
        MIC_MISSED_SENTENCE,
      ]
    : [`OpenWhispr recorded this ${formatElapsedMinutes(kept.elapsedSeconds)} meeting.`];
  if (unsavedMs > 0) {
    sentences.push(
      `OpenWhispr could not transcribe ${formatRecordedMinutes(Math.floor(unsavedMs / 1000))} of the recording.`,
    );
  }
  if (input.owedMs > 0) {
    sentences.push(
      `The transcript is still missing ${formatRecordedMinutes(Math.floor(input.owedMs / 1000))} of the recording, which is transcribed from audio saved on this device the next time OpenWhispr is open with a connection.`,
    );
  }
  return {
    title: kept.isPartial ? PARTIAL_CAPTURE_TITLE : UNTRANSCRIBED_CAPTURE_TITLE,
    message: sentences.join(' '),
  };
}
