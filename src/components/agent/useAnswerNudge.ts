import { useCallback, useEffect, useRef, useState } from "react";

/** How long a card waits while compact before the modal opens to it. */
export const ANSWER_NUDGE_MS = 4000;

/**
 * A card waits on the user while the window is compact: Expand pulses blue
 * (`cue`), and after a few seconds the modal opens to the card (`onOpen`).
 * Each card opens this way once. A card is done with it when the timer fires
 * or the user acts on the card (`cancel`: they start on it, press Expand or
 * Keyboard); answered or dismissed, it is gone. Anything else that stops it
 * (the modal opening by itself, the window hiding, a voice take) only pauses
 * it, and minimizing again starts it over. Moving between the compact
 * layouts (pill, the card above it) keeps it running.
 */
export function useAnswerNudge({
  pendingKey,
  compact,
  visible,
  paused = false,
  onOpen,
}: {
  pendingKey: string | null;
  compact: boolean;
  visible: boolean;
  /** A voice take is recording or being transcribed. */
  paused?: boolean;
  onOpen: () => void;
}): { cue: boolean; cancel: () => void } {
  const doneKeys = useRef(new Set<string>());
  const timer = useRef<{ key: string; id: ReturnType<typeof setTimeout> } | null>(null);
  const [cue, setCue] = useState(false);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const keyRef = useRef(pendingKey);
  keyRef.current = pendingKey;

  const stop = useCallback(() => {
    if (!timer.current) return;
    clearTimeout(timer.current.id);
    timer.current = null;
    setCue(false);
  }, []);

  const cancel = useCallback(() => {
    if (keyRef.current !== null) doneKeys.current.add(keyRef.current);
    stop();
  }, [stop]);

  const waiting = pendingKey !== null && compact && visible && !paused;
  useEffect(() => {
    if (timer.current && (!waiting || timer.current.key !== pendingKey)) stop();
    if (!waiting || pendingKey === null || timer.current || doneKeys.current.has(pendingKey)) {
      return;
    }
    setCue(true);
    timer.current = {
      key: pendingKey,
      id: setTimeout(() => {
        doneKeys.current.add(pendingKey);
        timer.current = null;
        setCue(false);
        onOpenRef.current();
      }, ANSWER_NUDGE_MS),
    };
  }, [pendingKey, stop, waiting]);

  useEffect(() => stop, [stop]);

  return { cue, cancel };
}
