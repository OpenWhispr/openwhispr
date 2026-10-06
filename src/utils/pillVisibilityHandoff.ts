import { waitForVisualFrames } from "./visualFrame";

interface PillVisibilityHandoffOptions {
  onSuppressedChange: (suppressed: boolean) => void;
  shouldAutoHide?: () => boolean;
  hideWindow?: () => Promise<unknown> | undefined;
  waitForFrames?: () => Promise<void>;
}

/**
 * Hide the persistent pill root across a risky native resize, independently of
 * React renders. Two callers own one each: the dictation-error return and the
 * panel return (useMainWindowSizeOwner). A fresh suppress invalidates every
 * pending release, while a successful release waits for native geometry and
 * compositor frames before exposing the pill again.
 */
export function createPillVisibilityHandoff({
  onSuppressedChange,
  shouldAutoHide = () => false,
  hideWindow = () => undefined,
  waitForFrames = waitForVisualFrames,
}: PillVisibilityHandoffOptions) {
  let generation = 0;
  let suppressed = false;
  let disposed = false;

  const publish = (next: boolean) => {
    if (suppressed === next) return;
    suppressed = next;
    onSuppressedChange(next);
  };

  return {
    suppress() {
      generation += 1;
      publish(true);
    },

    async releaseAfter(settleBounds: () => Promise<unknown>) {
      const releaseGeneration = ++generation;
      try {
        await settleBounds();
        if (disposed || releaseGeneration !== generation) {
          return { released: false, superseded: true };
        }

        if (shouldAutoHide()) {
          await hideWindow();
        } else {
          await waitForFrames();
        }
      } catch {
        // A destroyed native window should not strand the next renderer mount
        // in a permanently suppressed state.
      }

      if (disposed || releaseGeneration !== generation) {
        return { released: false, superseded: true };
      }
      publish(false);
      return { released: true, superseded: false };
    },

    cancel() {
      generation += 1;
    },

    dispose() {
      disposed = true;
      generation += 1;
    },
  };
}
