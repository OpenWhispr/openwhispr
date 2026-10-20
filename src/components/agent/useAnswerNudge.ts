import { useCallback, useEffect, useRef, useState } from "react";

/** How long a card waits while compact before the modal opens to it. */
export const ANSWER_NUDGE_MS = 4000;

/**
 * A card waits on the user while the window is compact: Expand pulses blue
 * (`cue`), and after a few seconds the modal opens to the card (`onOpen`).
 * Each card gets this once. It stops for good when the card is answered or
 * dismissed, the modal opens, the user starts on the card (`cancel`), or the
 * window hides; minimizing again later never brings it back. Moving between
 * the compact layouts (pill, the card above it) keeps it running.
 */
export function useAnswerNudge({
  pendingKey,
  compact,
  visible,
  onOpen,
}: {
  pendingKey: string | null;
  compact: boolean;
  visible: boolean;
  onOpen: () => void;
}): { cue: boolean; cancel: () => void } {
  const armedKeys = useRef(new Set<string>());
  const timer = useRef<{ key: string; id: ReturnType<typeof setTimeout> } | null>(null);
  const [cue, setCue] = useState(false);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const cancel = useCallback(() => {
    if (!timer.current) return;
    clearTimeout(timer.current.id);
    timer.current = null;
    setCue(false);
  }, []);

  const waiting = pendingKey !== null && compact && visible;
  useEffect(() => {
    if (timer.current && (!waiting || timer.current.key !== pendingKey)) cancel();
    if (!waiting || pendingKey === null || armedKeys.current.has(pendingKey)) return;
    armedKeys.current.add(pendingKey);
    setCue(true);
    timer.current = {
      key: pendingKey,
      id: setTimeout(() => {
        timer.current = null;
        setCue(false);
        onOpenRef.current();
      }, ANSWER_NUDGE_MS),
    };
  }, [cancel, pendingKey, waiting]);

  useEffect(() => cancel, [cancel]);

  return { cue, cancel };
}
