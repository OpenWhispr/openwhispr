import { useEffect, useState } from "react";

/**
 * Mirrors `flag` after it has stayed true for `delayMs`, so short server
 * round-trips never flash a spinner. Resets to false immediately.
 */
export function useDelayedFlag(flag: boolean, delayMs = 300): boolean {
  const [delayed, setDelayed] = useState(false);

  useEffect(() => {
    if (!flag) {
      setDelayed(false);
      return;
    }
    const timer = setTimeout(() => setDelayed(true), delayMs);
    return () => clearTimeout(timer);
  }, [flag, delayMs]);

  return delayed;
}
