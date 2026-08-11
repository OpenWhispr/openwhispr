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

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const result = await window.electronAPI?.checkScreenRecordingAccess?.();
      setAccess(result ?? DEFAULT_ACCESS);
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    check();
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
    try {
      const result = await window.electronAPI?.requestScreenRecordingAccess?.();
      const next = result ?? DEFAULT_ACCESS;
      setAccess(next);
      return next.granted;
    } catch {
      return false;
    }
  }, []);

  return {
    granted: access?.granted ?? false,
    supported: access?.supported ?? true,
    request,
    isMacOS,
  };
}
