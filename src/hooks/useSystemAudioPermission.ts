import { useState, useCallback, useEffect, useRef } from "react";
import { getCachedPlatform } from "../utils/platform";
import type { SystemAudioAccessResult } from "../types/electron";
import { DEFAULT_SYSTEM_AUDIO_ACCESS } from "../utils/systemAudioAccess";

export function useSystemAudioPermission() {
  const isMacOS = getCachedPlatform() === "darwin";
  const [access, setAccess] = useState<SystemAudioAccessResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const checkingRef = useRef(false);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setIsChecking(true);
    try {
      const result = await window.electronAPI?.checkSystemAudioAccess?.();
      setAccess(result ?? DEFAULT_SYSTEM_AUDIO_ACCESS);
    } finally {
      checkingRef.current = false;
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

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
    const currentAccess =
      access ??
      (await window.electronAPI?.checkSystemAudioAccess?.()) ??
      DEFAULT_SYSTEM_AUDIO_ACCESS;

    if (currentAccess.mode === "loopback") {
      setAccess(currentAccess);
      return currentAccess.granted;
    }

    if (currentAccess.mode === "portal") {
      if (!currentAccess.supportsOnboardingGrant) {
        setAccess(currentAccess);
        return currentAccess.granted;
      }
    } else if (currentAccess.mode !== "native") {
      setAccess(currentAccess);
      return false;
    }

    setIsChecking(true);
    try {
      const result = await window.electronAPI?.requestSystemAudioAccess?.();
      const nextAccess = result ?? currentAccess;
      setAccess(nextAccess);
      return nextAccess.granted;
    } catch {
      return false;
    } finally {
      setIsChecking(false);
    }
  }, [access]);

  const granted = access?.granted ?? false;
  const status = access?.status ?? "unknown";
  const mode = access?.mode ?? "unsupported";
  const supportsPersistentGrant = access?.supportsPersistentGrant ?? false;
  const supportsPersistentPortalGrant = access?.supportsPersistentPortalGrant ?? false;
  const supportsNativeCapture = access?.supportsNativeCapture ?? false;
  const supportsOnboardingGrant = access?.supportsOnboardingGrant ?? false;
  const requiresRuntimeSharePrompt = access?.requiresRuntimeSharePrompt ?? false;
  const strategy = access?.strategy ?? "unsupported";
  const restoreTokenAvailable = access?.restoreTokenAvailable ?? false;
  const portalVersion = access?.portalVersion ?? null;

  return {
    granted,
    status,
    mode,
    supportsPersistentGrant,
    supportsPersistentPortalGrant,
    supportsNativeCapture,
    supportsOnboardingGrant,
    requiresRuntimeSharePrompt,
    strategy,
    restoreTokenAvailable,
    portalVersion,
    isChecking,
    request,
    openSettings,
    check,
    isMacOS,
  };
}
