import { useState, useCallback, useEffect, useRef } from "react";
import { getCachedPlatform } from "../utils/platform";

export function useScreenRecordingPermission() {
  const isMacOS = getCachedPlatform() === "darwin";
  const [granted, setGranted] = useState(!isMacOS);
  const checkingRef = useRef(false);

  const check = useCallback(async () => {
    if (!isMacOS || checkingRef.current) return;
    checkingRef.current = true;
    try {
      const result = await window.electronAPI?.checkScreenRecordingAccess?.();
      setGranted(result?.granted ?? false);
    } finally {
      checkingRef.current = false;
    }
  }, [isMacOS]);

  // Check on mount
  useEffect(() => {
    check();
  }, [check]);

  // Re-check when the window regains focus (user may have just toggled it in System Settings)
  useEffect(() => {
    if (!isMacOS) return;
    const handleFocus = () => check();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isMacOS, check]);

  const openSettings = useCallback(async () => {
    await window.electronAPI?.openScreenRecordingSettings?.();
  }, []);

  // Trigger the native macOS permission prompt via getDisplayMedia (used in onboarding)
  const request = useCallback(async (): Promise<boolean> => {
    if (!isMacOS) return true;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      stream.getTracks().forEach((t) => t.stop());
      setGranted(true);
      return true;
    } catch {
      return false;
    }
  }, [isMacOS]);

  return { granted, request, openSettings, check, isMacOS };
}
