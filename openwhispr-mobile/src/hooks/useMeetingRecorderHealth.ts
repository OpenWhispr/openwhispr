import { useEffect, useRef, useState } from 'react';

export interface RecorderHealth {
  capturing: boolean;
  capturedMs: number;
}

export interface HealthRecorder {
  getStatus(): { isRecording: boolean; durationMillis: number };
  record(): void;
}

const POLL_MS = 1000;
const RESUME_RETRY_MS = 2000;

const IDLE_HEALTH: RecorderHealth = { capturing: false, capturedMs: 0 };

/**
 * Polls once a second while `active`; asks a paused recorder to resume at most every 2 s, and only
 * while `shouldResume()` allows it (not during a stop).
 */
export function useMeetingRecorderHealth(
  recorder: HealthRecorder | null,
  active: boolean,
  shouldResume: () => boolean,
): RecorderHealth {
  const [health, setHealth] = useState<RecorderHealth>(IDLE_HEALTH);
  // A ref, so a new function identity doesn't restart the polling.
  const shouldResumeRef = useRef(shouldResume);
  shouldResumeRef.current = shouldResume;

  useEffect(() => {
    if (!recorder || !active) return;
    let lastResumeAt = Number.NEGATIVE_INFINITY;

    const poll = (): void => {
      let status: ReturnType<HealthRecorder['getStatus']>;
      try {
        status = recorder.getStatus();
      } catch {
        // A recorder that is mid-teardown can throw; report it as not capturing.
        status = { isRecording: false, durationMillis: 0 };
      }
      if (!status.isRecording && shouldResumeRef.current()) {
        const now = Date.now();
        if (now - lastResumeAt >= RESUME_RETRY_MS) {
          lastResumeAt = now;
          try {
            recorder.record();
          } catch {
            // The next attempt is two seconds away; the screen already shows the recorder as paused.
          }
        }
      }
      setHealth((previous) =>
        previous.capturing === status.isRecording && previous.capturedMs === status.durationMillis
          ? previous
          : { capturing: status.isRecording, capturedMs: status.durationMillis },
      );
    };

    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [recorder, active]);

  return health;
}
