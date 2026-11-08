import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalSetupSpace } from "../../types/electron";

export type LocalSetupSpaceReading = LocalSetupSpace & { refresh: () => void };

/**
 * Free disk space for the local setup downloads, with the room each kind
 * reserves. `space` is null until the first read lands (or while it keeps
 * failing); `settled` turns true once the first read has answered either way. It
 * is read once on mount, so the figure is ready by the step that shows it, and on
 * refresh(). While `watchFocus` is true it is also read again when the window
 * regains focus, so space freed in Finder or Explorer shows up.
 */
export function useLocalSetupSpace(watchFocus = true): {
  space: LocalSetupSpaceReading | null;
  settled: boolean;
} {
  const [space, setSpace] = useState<LocalSetupSpace | null>(null);
  const [settled, setSettled] = useState(false);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  const refresh = useCallback(() => {
    const request = ++requestRef.current;
    window.electronAPI
      ?.getLocalSetupSpace?.()
      .then((next) => {
        if (mountedRef.current && request === requestRef.current && next) setSpace(next);
      })
      .catch(() => {})
      .finally(() => {
        if (mountedRef.current) setSettled(true);
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!watchFocus) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [watchFocus, refresh]);

  const reading = useMemo(() => (space ? { ...space, refresh } : null), [space, refresh]);
  return { space: reading, settled };
}
