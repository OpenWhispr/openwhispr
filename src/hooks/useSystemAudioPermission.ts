import { useState, useCallback, useEffect, useRef } from "react";
import { getCachedPlatform } from "../utils/platform";
import type { SystemAudioAccessResult } from "../types/electron";
import { DEFAULT_SYSTEM_AUDIO_ACCESS } from "../utils/systemAudioAccess";

export function useSystemAudioPermission() {
  const isMacOS = getCachedPlatform() === "darwin";
  const [access, setAccess] = useState<SystemAudioAccessResult | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const checkingRef = useRef(false);
  const requestId = useRef(0);

  const check = useCallback(async () => {
    if (checkingRef.current) return;
    const request = ++requestId.current;
    checkingRef.current = true;
    setIsChecking(true);
    try {
      const result = await window.electronAPI?.checkSystemAudioAccess?.();
      if (request === requestId.current) setAccess(result ?? DEFAULT_SYSTEM_AUDIO_ACCESS);
    } catch {
      // An unavailable refresh must not discard a previously confirmed grant.
    } finally {
      if (request === requestId.current) {
        checkingRef.current = false;
        setIsChecking(false);
      }
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
    const id = ++requestId.current;
    checkingRef.current = true;
    setIsChecking(true);
    try {
      const currentAccess =
        access ??
        (await window.electronAPI?.checkSystemAudioAccess?.()) ??
        DEFAULT_SYSTEM_AUDIO_ACCESS;
      if (id !== requestId.current) return false;

      if (
        currentAccess.mode === "loopback" ||
        (currentAccess.mode === "portal" && !currentAccess.supportsOnboardingGrant)
      ) {
        setAccess(currentAccess);
        return currentAccess.granted;
      }
      if (currentAccess.mode !== "native" && currentAccess.mode !== "portal") {
        setAccess(currentAccess);
        return false;
      }

      const result = await window.electronAPI?.requestSystemAudioAccess?.();
      if (id !== requestId.current) return false;
      const nextAccess = result ?? currentAccess;
      setAccess(nextAccess);
      return nextAccess.granted;
    } catch {
      return false;
    } finally {
      if (id === requestId.current) {
        checkingRef.current = false;
        setIsChecking(false);
      }
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
    loaded: access !== null,
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
