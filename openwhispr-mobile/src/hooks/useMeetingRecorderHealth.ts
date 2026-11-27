import { useEffect, useRef, useState } from 'react';

export interface RecorderHealth {
  capturing: boolean;
  capturedMs: number;
}

export interface HealthRecorder {
  // The native recorder's own state.
  readonly isRecording: boolean;
  // expo-audio's record of its state, which keeps saying recording after iOS pauses the recorder
  // for a call or refuses a record() while the call holds the microphone.
  getStatus(): { isRecording: boolean };
  pause(): void;
  record(): void;
}

const POLL_MS = 1000;
const MAX_POLL_GAP_MS = 2 * POLL_MS;
const RESUME_RETRY_MS = 2000;

const IDLE_HEALTH: RecorderHealth = { capturing: false, capturedMs: 0 };
// The recorder was just started, so until the first poll says otherwise it is capturing; reading
// "not capturing" here would flash a false "Not recording" at the start of every meeting.
const STARTING_HEALTH: RecorderHealth = { capturing: true, capturedMs: 0 };

function isCapturing(recorder: HealthRecorder): boolean {
  try {
    return recorder.isRecording;
  } catch {
    // A recorder that is mid-teardown can throw; report it as not capturing.
    return false;
  }
}

function resume(recorder: HealthRecorder): void {
  try {
    // expo's record() does nothing unless its own state is paused, and that state still reads
    // recording when iOS paused the recorder without telling it.
    if (recorder.getStatus().isRecording) recorder.pause();
    recorder.record();
    // Refused while a call holds the microphone, which leaves expo reading recording again and
    // would make its own resume when the call ends a no-op. That resume can't wait for the next
    // attempt here: the app may be suspended by then. Only while expo reads recording: Android's
    // record() on an unprepared recorder does nothing, and pausing that would block its next prepare.
    if (!recorder.isRecording && recorder.getStatus().isRecording) recorder.pause();
  } catch {
    // The next attempt is two seconds away; the screen already shows the recorder as paused.
  }
}

/**
 * Polls once a second while `active`; each active period starts as capturing at zero, and the
 * last values are kept once it ends (processing still reads the captured time). Capture comes
 * from the native recorder and the captured time is counted here, since expo's `durationMillis`
 * keeps counting while the native recorder is stopped. Asks a paused recorder to resume at most
 * every 2 s, and only while `shouldResume()` allows it (not during a stop).
 */
export function useMeetingRecorderHealth(
  recorder: HealthRecorder | null,
  active: boolean,
  shouldResume: () => boolean,
): RecorderHealth {
  const [health, setHealth] = useState<RecorderHealth>(IDLE_HEALTH);
  const polling = active && recorder != null;
  const [wasPolling, setWasPolling] = useState(false);
  // Adjusted during render, not in an effect, so the first render of a new period already shows
  // the starting state instead of the previous period's last values.
  const periodStarting = polling && !wasPolling;
  if (polling !== wasPolling) {
    setWasPolling(polling);
    if (periodStarting) setHealth(STARTING_HEALTH);
  }
  // A ref, so a new function identity doesn't restart the polling.
  const shouldResumeRef = useRef(shouldResume);
  shouldResumeRef.current = shouldResume;

  useEffect(() => {
    if (!recorder || !active) return;
    let lastResumeAt = Number.NEGATIVE_INFINITY;
    let lastPollAt = 0;
    let wasCapturing = false;
    let capturedMs = 0;

    const poll = (): void => {
      const now = Date.now();
      const capturing = isCapturing(recorder);
      // Only the time between two polls that both saw it capturing counts: a second it stopped
      // or resumed in is left out rather than counted while nothing may have been recorded. A
      // longer gap means the app was suspended in between, through a call expo paused and resumed
      // the recorder for, so at most one missed poll of it counts.
      if (capturing && wasCapturing) capturedMs += Math.min(now - lastPollAt, MAX_POLL_GAP_MS);
      lastPollAt = now;
      wasCapturing = capturing;
      if (!capturing && shouldResumeRef.current() && now - lastResumeAt >= RESUME_RETRY_MS) {
        lastResumeAt = now;
        resume(recorder);
      }
      const next: RecorderHealth = { capturing, capturedMs };
      setHealth((previous) =>
        previous.capturing === next.capturing && previous.capturedMs === next.capturedMs
          ? previous
          : next,
      );
    };

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [recorder, active]);

  return periodStarting ? STARTING_HEALTH : health;
}
