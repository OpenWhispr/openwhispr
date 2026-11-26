/**
 * Pure decisions for a cloud meeting's recording state, kept out of `useCloudMeeting`
 * so they can be unit-tested without React.
 */
import type { RealtimeUtterance } from '@/services/transcription/realtimeEvents';

/** Where the app-wide meeting session is: idle, recording (on-device or cloud), or finishing. */
export type MeetingSessionPhase = 'idle' | 'recording' | 'cloud-recording' | 'processing';

export type CloudMeetingStatus =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'recording-only'
  | 'interrupted'
  | 'error';

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
  /**
   * The live stream gave up for good while the recording goes on, so the rest of the meeting is
   * transcribed from the file after Stop.
   */
  streamEnded?: boolean;
}): CloudMeetingStatus {
  if (input.failed) return 'error';
  if (!input.started) return 'connecting';
  if (!input.capturing) return 'interrupted';
  if (input.streamEnded) return 'recording-only';
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
  return status === 'live' || status === 'reconnecting' || status === 'recording-only';
}

/**
 * Whether the screen and lock screen should read as recording. A reconnect still captures
 * audio and sends it once the socket returns, a session still connecting hasn't lost anything
 * yet, and one whose live stream ended still writes the recording; only a stopped mic or an
 * ended session has lost audio.
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
  streamEnded: boolean;
  error: string | null;
  partialText: string;
  utterances: RealtimeUtterance[];
  capturedSeconds: number;
  droppedSeconds: number;
  interruptions: number;
  reconnects: number;
  utteranceCount: number;
  /** Set when the session never started; mid-meeting failures leave it null. */
  startFailure: MeetingStartFailure | null;
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
    streamEnded: false,
    error: null,
    partialText: '',
    utterances: [],
    capturedSeconds: 0,
    droppedSeconds: 0,
    interruptions: 0,
    reconnects: 0,
    utteranceCount: 0,
    startFailure: null,
    clock: { lastCapturedMs: 0, lastGrowthAtMs: nowMs },
  };
}

/**
 * Why a cloud meeting never started: its session's start was refused, or the org refused the
 * meeting before any token was granted. Either way no recording of it is kept.
 */
export interface MeetingStartFailure {
  /** The native rejection code (`MIC_UNAVAILABLE`, `MIC_PERMISSION_DENIED`, …); null when none. */
  code: string | null;
  message: string;
}

export function meetingStartFailureFrom(error: unknown): MeetingStartFailure {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    code: typeof code === 'string' ? code : null,
    message: error instanceof Error ? error.message : String(error),
  };
}

const MIC_HELD_BY_CALL_MESSAGE = "Can't record during a call. End the call, then try again.";

/** What to tell the user about a start that failed: the microphone access alert, or a message. */
export type MeetingStartFailureNotice =
  | { kind: 'mic-permission' }
  | { kind: 'message'; message: string };

/** The text as a sentence: trimmed, with a period unless it ends in . ! ? or …; '' when blank. */
export function asSentence(text: string | null | undefined): string {
  const trimmed = text?.trim();
  if (!trimmed) return '';
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function meetingStartFailureNotice(failure: MeetingStartFailure): MeetingStartFailureNotice {
  if (failure.code === 'MIC_PERMISSION_DENIED') return { kind: 'mic-permission' };
  // Builds from before MIC_UNAVAILABLE report a call holding the audio session only through
  // iOS's (English) description of the refused activation.
  if (
    failure.code === 'MIC_UNAVAILABLE' ||
    (failure.code === 'PCM_START_FAILED' && failure.message.includes('Session activation failed'))
  ) {
    return { kind: 'message', message: MIC_HELD_BY_CALL_MESSAGE };
  }
  const reason = asSentence(failure.message);
  if (!reason) return { kind: 'message', message: "Couldn't start recording." };
  return { kind: 'message', message: `Couldn't start recording. ${reason}` };
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

export const STATUS_LABEL: Record<CloudMeetingStatus, string> = {
  connecting: 'CONNECTING',
  live: 'RECORDING',
  reconnecting: 'RECONNECTING',
  'recording-only': 'RECORDING ONLY',
  interrupted: 'NOT RECORDING',
  error: 'DISCONNECTED',
};

/** `mm:ss` of captured time, `h:mm:ss` once it passes an hour. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${minutes}:${secs}` : `${minutes}:${secs}`;
}

export interface MeetingBarState {
  label: string;
  recordingAudio: boolean;
  showClock: boolean;
  showStop: boolean;
}

/** What the in-app "meeting in progress" bar shows for the session's current state. */
export function meetingBarState(input: {
  phase: MeetingSessionPhase;
  path: 'local' | 'cloud';
  capturing: boolean;
  cloudStatus: CloudMeetingStatus;
  /** Cloud only: capture has begun, so a still-connecting meeting is already recording. */
  captureStarted?: boolean;
}): MeetingBarState {
  if (input.phase === 'processing') {
    return { label: 'FINISHING…', recordingAudio: false, showClock: false, showStop: false };
  }
  if (input.path === 'cloud') {
    return {
      label: STATUS_LABEL[input.cloudStatus],
      recordingAudio: isCloudMeetingRecordingAudio(
        input.cloudStatus,
        input.captureStarted ?? false,
      ),
      showClock: true,
      showStop: true,
    };
  }
  return {
    label: input.capturing ? 'RECORDING' : 'NOT RECORDING',
    recordingAudio: input.capturing,
    showClock: true,
    showStop: true,
  };
}
