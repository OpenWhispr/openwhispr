import { useEffect, useRef, useState } from "react";

/**
 * A label that switches on immediately and off through a fade: the caller
 * renders the "active" copy while `showActive`, at opacity 0 while `fading`,
 * so the revert reads as a crossfade instead of a hard swap.
 */
export function useCrossfadedLabel(
  active: boolean,
  revertMs: number
): { showActive: boolean; fading: boolean } {
  const [showActive, setShowActive] = useState(active);
  const [fading, setFading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (active) {
      setShowActive(true);
      setFading(false);
      return;
    }
    if (!showActive) return;
    setFading(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setShowActive(false);
      setFading(false);
    }, revertMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // showActive is intentionally read, not tracked: a revert must not re-arm itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, revertMs]);

  return { showActive, fading };
}
