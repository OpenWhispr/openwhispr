type FrameScheduler = (callback: FrameRequestCallback) => number;

// Chromium pauses requestAnimationFrame in hidden/occluded windows (the main
// window disables backgroundThrottling, but an occluded or minimised window
// can still stop painting), so an unbounded rAF wait could stall a dictation
// stop indefinitely while the mic keeps recording.
// Each awaited frame races this timeout so the wait always resolves.
export const VISUAL_FRAME_TIMEOUT_MS = 250;

/**
 * Let React commit an optimistic visual state and let Chromium submit it to
 * the compositor before starting work that can wake a slow OS device driver.
 * Bounded: with rAF throttled, resolves after frameCount * VISUAL_FRAME_TIMEOUT_MS.
 */
export function waitForVisualFrames(
  frameCount = 2,
  scheduleFrame: FrameScheduler = requestAnimationFrame,
  frameTimeoutMs = VISUAL_FRAME_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve) => {
    const wait = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const advance = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wait(remaining - 1);
      };
      timer = setTimeout(advance, frameTimeoutMs);
      scheduleFrame(advance);
    };
    wait(Math.max(0, frameCount));
  });
}
