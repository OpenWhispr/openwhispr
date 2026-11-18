import { AndroidDictation } from './index';

// Kept out of index.ts, which the iOS bundle loads: only Android Settings imports this.
export interface BubbleAppearance {
  /** Bubble size in dp, 48..80 from the slider (the native side clamps to 48..88). */
  size: number;
  /** The idle bubble's opacity, 0.2..1. Dictating, writing and results are always opaque. */
  opacity: number;
  /** Shrink after 5 s idle; a touch, a newly focused field or a dictation brings it back. */
  shrinkWhenIdle: boolean;
  /** Shrink to a small blue dot instead of a smaller bubble. */
  shrinkToDot: boolean;
  /** Show the bubble shrunk while a search field is focused. */
  shrinkInSearch: boolean;
}

/** Stores the bubble's look and applies it to a running bubble; a no-op on older native builds. */
export function setBubbleAppearance(options: BubbleAppearance): void {
  (
    AndroidDictation as { setAppearance?: (options: BubbleAppearance) => void } | null
  )?.setAppearance?.(options);
}
