import { useLayoutEffect, useRef, type RefObject } from "react";

interface LinuxPillInteractivityOptions {
  pillRef: RefObject<HTMLElement | null>;
  captureWindow: boolean;
  pillInteractive: boolean;
}

// Native input shaping leaves hover delivery to the compositor, including
// when the pointer crosses between XWayland and native Wayland applications.
// Windows uses the same samples as a window shape. Click-through forwarding
// drops button presses on this panel, and SetWindowRgn also clips painting,
// so the glow and tooltip are included in the measured box.
const WINDOWS_SHAPE_PAD_PX = 12;

function boxOf(rect: {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const left = Number.isFinite(rect.left) ? rect.left : rect.x;
  const top = Number.isFinite(rect.top) ? rect.top : rect.y;
  const right = Number.isFinite(rect.right) ? rect.right : left + rect.width;
  const bottom = Number.isFinite(rect.bottom) ? rect.bottom : top + rect.height;
  return { left, top, right, bottom };
}

function measuredPillRect(
  element: HTMLElement | null,
  platform: string | undefined
): { x: number; y: number; width: number; height: number } | null {
  if (!element) return null;
  const boxes = [boxOf(element.getBoundingClientRect())];
  if (platform === "win32") {
    for (const node of element.querySelectorAll("*")) {
      boxes.push(boxOf(node.getBoundingClientRect()));
    }
  }
  const visible = boxes.filter((box) => box.right > box.left && box.bottom > box.top);
  if (!visible.length) return null;
  let left = Math.min(...visible.map((box) => box.left));
  let top = Math.min(...visible.map((box) => box.top));
  let right = Math.max(...visible.map((box) => box.right));
  let bottom = Math.max(...visible.map((box) => box.bottom));
  if (platform === "win32") {
    left -= WINDOWS_SHAPE_PAD_PX;
    top -= WINDOWS_SHAPE_PAD_PX;
    right += WINDOWS_SHAPE_PAD_PX;
    bottom += WINDOWS_SHAPE_PAD_PX;
    left = Math.max(0, left);
    top = Math.max(0, top);
    right = Math.min(window.innerWidth, right);
    bottom = Math.min(window.innerHeight, bottom);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function useLinuxPillInteractivity({
  pillRef,
  captureWindow,
  pillInteractive,
}: LinuxPillInteractivityOptions): void {
  const nativeVisibleRef = useRef(true);
  useLayoutEffect(() => {
    const api = window.electronAPI;
    const platform = api?.getPlatform?.();
    if (platform !== "linux" && platform !== "win32") return;
    let disposed = false;
    let generation = 0;
    let pending = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const stop = (): void => {
      generation += 1;
      clearInterval(timer);
      timer = undefined;
    };
    const applyRegion = async (
      region: Parameters<typeof api.setMainWindowInputRegion>[0]
    ): Promise<void> => {
      const requestGeneration = generation;
      try {
        const visible = await api.setMainWindowInputRegion(region);
        if (disposed || requestGeneration !== generation) return;
        if (!visible) {
          nativeVisibleRef.current = false;
          stop();
        }
      } catch {
        // The native writer restores full input when shaping is unavailable.
        // A failure from an older effect must not stop its replacement.
        if (!disposed && requestGeneration === generation) stop();
      }
    };
    const sample = async (): Promise<void> => {
      if (disposed || pending || !nativeVisibleRef.current || document.hidden) return;
      pending = true;
      try {
        const rect = pillInteractive ? measuredPillRect(pillRef.current, platform) : null;
        await applyRegion({
          x: rect?.x ?? 0,
          y: rect?.y ?? 0,
          width: rect?.width ?? 0,
          height: rect?.height ?? 0,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        });
      } finally {
        pending = false;
      }
    };
    const start = (): void => {
      stop();
      if (!nativeVisibleRef.current) return;
      if (captureWindow) {
        // Full input joins the same native FIFO immediately, even while an
        // older narrow-region update is still awaiting acknowledgement.
        void applyRegion(null);
        return;
      }
      // Reapply even unchanged geometry: native resizes can reset input shape.
      timer = setInterval(() => void sample(), 50);
      void sample();
    };
    const unsubscribe = api.onMainWindowVisibilityChanged((visible) => {
      nativeVisibleRef.current = visible;
      if (visible) start();
      else stop();
    });
    start();
    return () => {
      disposed = true;
      stop();
      unsubscribe();
      // The native writer orders this after any pending narrow-region update.
      void api.setMainWindowInputRegion(null).catch(() => {});
    };
  }, [captureWindow, pillInteractive, pillRef]);
}
