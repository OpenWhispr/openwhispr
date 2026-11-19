import { useEffect, useState } from "react";
import type { ComputerProfile } from "../types/electron";
import logger from "../utils/logger";

// One read per window: main caches it for the process, and so do we.
let profilePromise: Promise<ComputerProfile | null> | null = null;

function loadComputerProfile(): Promise<ComputerProfile | null> {
  if (!profilePromise) {
    profilePromise = Promise.resolve()
      .then(() => window.electronAPI.getComputerProfile())
      .catch((error) => {
        logger.warn("Failed to read the computer profile", { error }, "onboarding");
        profilePromise = null; // a later mount may try again
        return null;
      });
  }
  return profilePromise;
}

/** The computer's name, chip, memory and graphics; null until main has answered. */
export function useComputerProfile(): ComputerProfile | null {
  const [profile, setProfile] = useState<ComputerProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadComputerProfile().then((value) => {
      if (!cancelled) setProfile(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return profile;
}
