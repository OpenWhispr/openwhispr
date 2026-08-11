import { useCallback, useEffect, useState } from "react";
import type { MeetingDetectionHealth } from "../types/electron";

const POLL_MS = 30000;

/**
 * Reads the main process's passive record of what the meeting-detection stack is
 * doing. Polled rather than pushed: the interesting states persist, and a
 * detector going quiet is exactly the case a push would miss.
 */
export function useMeetingDetectionHealth(enabled = true) {
  const [health, setHealth] = useState<MeetingDetectionHealth | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await window.electronAPI?.getMeetingDetectionHealth?.();
      setHealth(next ?? null);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [enabled, refresh]);

  return { health, refresh };
}
