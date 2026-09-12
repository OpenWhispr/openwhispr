import { useLayoutEffect, type RefObject } from "react";

interface LinuxPillInteractivityOptions {
  pillRef: RefObject<HTMLElement | null>;
  captureWindow: boolean;
  pillInteractive: boolean;
  onHoverChange: (hovered: boolean) => void;
}

// Linux ignores Electron's hover forwarding. Hit-test the rendered pill so
// animation, cancel emergence and dock changes need no duplicate geometry.
export function useLinuxPillInteractivity({
  pillRef,
  captureWindow,
  pillInteractive,
  onHoverChange,
}: LinuxPillInteractivityOptions): void {
  useLayoutEffect(() => {
    const api = window.electronAPI;
    if (api?.getPlatform?.() !== "linux") return;
    let disposed = false;
    let generation = 0;
    let pending = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const stop = (): void => {
      generation += 1;
      clearInterval(timer);
      timer = undefined;
    };
    const poll = async (): Promise<void> => {
      if (disposed || pending || document.hidden) return;
      pending = true;
      const requestGeneration = generation;
      try {
        const point = await api.getMainWindowPointerPosition();
        if (disposed || requestGeneration !== generation) return;
        if (!point) {
          stop();
          onHoverChange(false);
          return;
        }
        const hovered = Boolean(
          pillInteractive && pillRef.current?.contains(document.elementFromPoint(point.x, point.y))
        );
        onHoverChange(hovered);
        await api.setMainWindowInteractivity(hovered);
      } catch {
        // Reload/teardown can reject either IPC. The next live poll retries.
      } finally {
        pending = false;
      }
    };
    const start = (): void => {
      stop();
      if (captureWindow) {
        // Never wait for a pointer reply before keeping controls or a drag
        // interactive. Cleanup invalidates any older click-through decision.
        void api.setMainWindowInteractivity(true).catch(() => {});
        return;
      }
      timer = setInterval(() => void poll(), 50);
      void poll();
    };
    const unsubscribe = api.onMainWindowVisibilityChanged((visible) => {
      if (visible) start();
      else {
        stop();
        onHoverChange(false);
      }
    });
    start();
    return () => {
      disposed = true;
      stop();
      unsubscribe();
    };
  }, [captureWindow, onHoverChange, pillInteractive, pillRef]);
}
