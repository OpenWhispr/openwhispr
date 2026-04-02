import { useState, useCallback, useEffect, useRef } from "react";
import { getCachedPlatform } from "../utils/platform";
import type { SystemAudioAccessResult } from "../types/electron";

const NON_MACOS_ACCESS: SystemAudioAccessResult = {
  granted: true,
  status: "granted",
  mode: "unsupported",
};

export function useSystemAudioPermission() {
  const isMacOS = getCachedPlatform() === "darwin";
  const [access, setAccess] = useState<SystemAudioAccessResult | null>(
    isMacOS ? null : NON_MACOS_ACCESS
  );
  const [isChecking, setIsChecking] = useState(false);
  const checkingRef = useRef(false);

  const check = useCallback(async () => {
    if (!isMacOS || checkingRef.current) return;
    checkingRef.current = true;
    setIsChecking(true);
    try {
      const result = await window.electronAPI?.checkSystemAudioAccess?.();
      setAccess(result ?? { granted: false, status: "unsupported", mode: "unsupported" });
    } finally {
      checkingRef.current = false;
      setIsChecking(false);
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
    await window.electronAPI?.openSystemAudioSettings?.();
  }, []);

  const request = useCallback(async (): Promise<boolean> => {
    if (!isMacOS) return true;

    setIsChecking(true);
    try {
      const currentAccess = access ??
        (await window.electronAPI?.checkSystemAudioAccess?.()) ?? {
          granted: false,
          status: "unsupported" as const,
          mode: "unsupported" as const,
        };

      if (currentAccess.mode !== "native") {
        setAccess(currentAccess);
        return false;
      }

      const result = await window.electronAPI?.requestSystemAudioAccess?.();
      const nextAccess = result ?? currentAccess;
      setAccess(nextAccess);
      return nextAccess.granted;
    } catch {
      return false;
    } finally {
      setIsChecking(false);
    }
  }, [access, isMacOS]);

  const granted = access?.granted ?? false;
  const status = access?.status ?? "unknown";
  const mode = access?.mode ?? "unsupported";

  return { granted, status, mode, isChecking, request, openSettings, check, isMacOS };
}
