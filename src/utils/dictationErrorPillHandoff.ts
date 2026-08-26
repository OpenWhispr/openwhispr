import { waitForVisualFrames } from "./visualFrame";

interface DictationErrorPillHandoffOptions {
  onSuppressedChange: (suppressed: boolean) => void;
  shouldAutoHide?: () => boolean;
  hideWindow?: () => Promise<unknown> | undefined;
  waitForFrames?: () => Promise<void>;
}

/**
 * Own the error-to-pill visibility handoff independently from React renders.
 * A new error invalidates every pending release, while a successful release
 * waits for native geometry and compositor frames before exposing the same
 * persistent pill root again.
 */
export function createDictationErrorPillHandoff({
  onSuppressedChange,
  shouldAutoHide = () => false,
  hideWindow = () => undefined,
  waitForFrames = waitForVisualFrames,
}: DictationErrorPillHandoffOptions) {
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
