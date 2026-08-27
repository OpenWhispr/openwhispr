export interface MainWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResizeResult {
  success: boolean;
  bounds?: MainWindowBounds;
  message?: string;
  superseded?: boolean;
  changed?: boolean;
}

interface ResizeRequest {
  signature: string;
  invoke: () => Promise<ResizeResult> | undefined;
}

interface QueueEntry {
  request: ResizeRequest;
  resolve: (result: ResizeResult) => void;
  reject: (error: unknown) => void;
}

interface CoordinatorOptions {
  resizeMainWindow: (sizeKey: string) => Promise<ResizeResult> | undefined;
  resizeAssistantWindowToContent: (height: number) => Promise<ResizeResult> | undefined;
  waitForBounds?: (bounds: MainWindowBounds) => Promise<void>;
}

const BOUNDS_TOLERANCE_PX = 2;
const SETTLED_FRAME_COUNT = 2;
const SETTLE_TIMEOUT_MS = 900;

const closeEnough = (actual: number, expected: number) =>
  Math.abs(actual - expected) <= BOUNDS_TOLERANCE_PX;

export type MainWindowResizeAnchor = "bottom-left" | "bottom-right" | "center";

/** Keep the configured bottom/side anchor fixed in screen space while the OS
 * delivers the move and resize halves of setBounds on different frames. */
export function calculateWindowAnchorCompensation(
  target: MainWindowBounds,
  current: MainWindowBounds,
  anchor: MainWindowResizeAnchor
) {
  const targetBottom = target.y + target.height;
  const currentBottom = current.y + current.height;
  const x =
    anchor === "bottom-left"
      ? target.x - current.x
      : anchor === "center"
        ? target.x + target.width / 2 - (current.x + current.width / 2)
        : target.x + target.width - (current.x + current.width);

  return { x, y: targetBottom - currentBottom };
}

/**
 * Wait until both halves of an Electron setBounds operation have reached the
 * renderer. On macOS and Windows the viewport resize and native window move
 * can arrive in separate compositor frames even though setBounds was atomic
 * in the main process.
 */
export function waitForRendererWindowBounds(bounds: MainWindowBounds): Promise<void> {
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const startedAt = performance.now();
    let stableFrames = 0;
    let frame = 0;

    const finish = () => {
      if (frame) window.cancelAnimationFrame(frame);
      resolve();
    };

    const sample = () => {
      const matches =
        closeEnough(window.screenX, bounds.x) &&
        closeEnough(window.screenY, bounds.y) &&
        closeEnough(window.innerWidth, bounds.width) &&
        closeEnough(window.innerHeight, bounds.height);

      stableFrames = matches ? stableFrames + 1 : 0;
      if (
        stableFrames >= SETTLED_FRAME_COUNT ||
        performance.now() - startedAt >= SETTLE_TIMEOUT_MS
      ) {
        finish();
        return;
      }
      frame = window.requestAnimationFrame(sample);
    };

    frame = window.requestAnimationFrame(sample);
  });
}

/**
 * A latest-wins serial queue for every voice-surface resize. It prevents a
 * content measurement, the generic size ladder, and a panel lifecycle edge
 * from issuing overlapping native geometry changes.
 */
export function createMainWindowResizeCoordinator({
  resizeMainWindow,
  resizeAssistantWindowToContent,
  waitForBounds = waitForRendererWindowBounds,
}: CoordinatorOptions) {
  let active: QueueEntry | null = null;
  let queued: QueueEntry | null = null;
  let disposed = false;
  let lastSignature: string | null = null;
  let lastResult: ResizeResult = { success: true };

  const run = async (entry: QueueEntry) => {
    active = entry;
    try {
      const result = (await entry.request.invoke()) ?? {
        success: false,
        message: "Window resize API unavailable",
      };
      if (result.success && result.bounds) await waitForBounds(result.bounds);
      lastSignature = entry.request.signature;
      lastResult = result;
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    } finally {
      active = null;
      if (disposed) {
        if (queued) {
          queued.resolve({ success: false, superseded: true, message: "Resize queue disposed" });
          queued = null;
        }
        return;
      }
      const next = queued;
      queued = null;
      if (next) void run(next);
    }
  };

  const enqueue = (request: ResizeRequest): Promise<ResizeResult> => {
    if (disposed) {
      return Promise.resolve({
        success: false,
        superseded: true,
        message: "Resize queue disposed",
      });
    }
    if (!active && !queued && request.signature === lastSignature) {
      // Nothing will move: report it so callers skip their post-grow wait.
      return Promise.resolve({ ...lastResult, changed: false });
    }

    return new Promise((resolve, reject) => {
      const entry = { request, resolve, reject };
      if (!active) {
        void run(entry);
        return;
      }

      // Repeated content chunks commonly arrive faster than the compositor.
      // Keep only the newest unapplied geometry instead of replaying every
      // obsolete intermediate height after the transcript has moved on.
      if (queued) {
        queued.resolve({
          success: false,
          superseded: true,
          message: "Superseded by a newer resize",
        });
      }
      queued = entry;
    });
  };

  return {
    resizeMainWindow(sizeKey: string) {
      return enqueue({
        signature: `size:${sizeKey}`,
        invoke: () => resizeMainWindow(sizeKey),
      });
    },
    resizeAssistantWindowToContent(height: number) {
      const roundedHeight = Math.max(1, Math.round(Number(height) || 0));
      return enqueue({
        signature: `assistant-content:${roundedHeight}`,
        invoke: () => resizeAssistantWindowToContent(roundedHeight),
      });
    },
    dispose() {
      disposed = true;
      if (queued) {
        queued.resolve({ success: false, superseded: true, message: "Resize queue disposed" });
        queued = null;
      }
    },
  };
}
