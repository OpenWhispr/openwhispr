import { useState, useCallback, useEffect, useRef } from "react";
import { getCachedPlatform } from "../utils/platform";
import type { ScreenRecordingAccessResult } from "../types/electron";

const DEFAULT_ACCESS: ScreenRecordingAccessResult = {
  granted: false,
  status: "unknown",
  supported: false,
};

export function useScreenRecordingPermission() {
  const isMacOS = getCachedPlatform() === "darwin";
  const [access, setAccess] = useState<ScreenRecordingAccessResult | null>(null);
  const checkingRef = useRef(false);
  const requestId = useRef(0);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    const request = ++requestId.current;
    checkingRef.current = true;
    try {
      const result = await window.electronAPI?.checkScreenRecordingAccess?.();
      if (request === requestId.current) setAccess(result ?? DEFAULT_ACCESS);
    } catch {
      // Keep a confirmed grant when an OS refresh is temporarily unavailable.
    } finally {
      if (request === requestId.current) checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void check();
    const requests = requestId;
    return () => {
      ++requests.current;
      checkingRef.current = false;
    };
  }, [check]);

  // Screen Recording is granted in System Settings, outside the app — re-check
  // when the user comes back.
  useEffect(() => {
    if (!isMacOS) return;
    const handleFocus = () => check();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isMacOS, check]);

  const request = useCallback(async (): Promise<boolean> => {
    const id = ++requestId.current;
    checkingRef.current = true;
    try {
      const result = await window.electronAPI?.requestScreenRecordingAccess?.();
      if (id !== requestId.current) return false;
      const next = result ?? DEFAULT_ACCESS;
      setAccess(next);
      return next.granted;
    } catch {
      return false;
    } finally {
      if (id === requestId.current) checkingRef.current = false;
    }
  }, []);

  return {
    granted: access?.granted ?? false,
    supported: access?.supported ?? true,
    needsRelaunch: access?.needsRelaunch ?? false,
    loaded: access !== null,
    check,
    request,
    isMacOS,
  };
}
