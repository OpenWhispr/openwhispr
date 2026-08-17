type FrameScheduler = (callback: FrameRequestCallback) => number;

/**
 * Let React commit an optimistic visual state and let Chromium submit it to
 * the compositor before starting work that can wake a slow OS device driver.
 */
export function waitForVisualFrames(
  frameCount = 2,
  scheduleFrame: FrameScheduler = requestAnimationFrame
): Promise<void> {
  return new Promise((resolve) => {
    const wait = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      scheduleFrame(() => wait(remaining - 1));
    };
    wait(Math.max(0, frameCount));
  });
}
