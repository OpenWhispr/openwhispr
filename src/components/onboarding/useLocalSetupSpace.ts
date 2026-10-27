import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalSetupSpace } from "../../types/electron";

export type LocalSetupSpaceReading = LocalSetupSpace & { refresh: () => void };

/**
 * Free disk space for the local setup downloads, with the room each kind
 * reserves. null until the first read lands (or while it keeps failing). It is
 * read once on mount, so the figure is ready by the step that shows it, and on
 * refresh(). While `watchFocus` is true it is also read again when the window
 * regains focus, so space freed in Finder or Explorer shows up.
 */
export function useLocalSetupSpace(watchFocus = true): LocalSetupSpaceReading | null {
  const [space, setSpace] = useState<LocalSetupSpace | null>(null);
  const mountedRef = useRef(false);
  const requestRef = useRef(0);

  const refresh = useCallback(() => {
    const request = ++requestRef.current;
    window.electronAPI
      ?.getLocalSetupSpace?.()
      .then((next) => {
        if (mountedRef.current && request === requestRef.current && next) setSpace(next);
      })
      .catch(() => {});
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

  return useMemo(() => (space ? { ...space, refresh } : null), [space, refresh]);
}
