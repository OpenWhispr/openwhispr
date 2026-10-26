import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalSetupSpace } from "../../types/electron";

export type LocalSetupSpaceReading = LocalSetupSpace & { refresh: () => void };

/**
 * Free disk space for the local setup downloads, with the room each kind
 * reserves. null until the first read lands (or while it keeps failing). It is
 * read again when the window regains focus, so space freed in Finder or Explorer
 * shows up, and on refresh().
 */
export function useLocalSetupSpace(): LocalSetupSpaceReading | null {
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
    window.addEventListener("focus", refresh);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  return useMemo(() => (space ? { ...space, refresh } : null), [space, refresh]);
}
