import { useEffect, useRef, useState } from 'react';

export function useMeetingElapsedTime(phase: string) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recordingStartedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (phase !== 'recording') {
      setElapsedSeconds(0);
      recordingStartedAtRef.current = null;
      return;
    }
    const updateElapsed = () => {
      const startedAt = recordingStartedAtRef.current;
      if (startedAt == null) return;
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    };
    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [phase]);

  return { elapsedSeconds, recordingStartedAtRef };
}
