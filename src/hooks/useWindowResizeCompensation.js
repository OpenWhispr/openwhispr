import { useEffect } from "react";
import { calculateWindowAnchorCompensation } from "../utils/mainWindowResizeCoordinator";

// Fractional DPI (Windows 125%/150%) rounds set-vs-reported bounds by up to
// 2px; the timeout backstops a plan whose bounds never materialize so content
// can't sit translated indefinitely. Both match the resize coordinator.
const BOUNDS_TOLERANCE_PX = 2;
const PLAN_SETTLE_TIMEOUT_MS = 900;

/**
 * Masks the visual jump of anchored native resizes. Electron applies a
 * split setBounds (position + size) across frames; this watches the window
 * bounds against the announced resize plan and counter-translates the
 * `.dictation-window` root via CSS variables until the bounds settle.
 */
export function useWindowResizeCompensation() {
  useEffect(() => {
    const root = document.querySelector(".dictation-window");
    if (!(root instanceof HTMLElement)) return undefined;

    let frame = 0;
    let plan = null;
    const clearCompensation = () => {
      root.style.setProperty("--window-resize-compensation-x", "0px");
      root.style.setProperty("--window-resize-compensation-y", "0px");
    };
    const currentBounds = () => ({
      x: window.screenX,
      y: window.screenY,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const differsFrom = (left, right) =>
      Math.abs(left.x - right.x) > BOUNDS_TOLERANCE_PX ||
      Math.abs(left.y - right.y) > BOUNDS_TOLERANCE_PX ||
      Math.abs(left.width - right.width) > BOUNDS_TOLERANCE_PX ||
      Math.abs(left.height - right.height) > BOUNDS_TOLERANCE_PX;

    const applyCompensation = (current) => {
      if (!plan) return;
      const compensation = calculateWindowAnchorCompensation(plan.bounds, current, plan.anchor);
      root.style.setProperty("--window-resize-compensation-x", `${compensation.x}px`);
      root.style.setProperty("--window-resize-compensation-y", `${compensation.y}px`);
    };

    // Chromium dispatches resize before painting the new viewport. Update the
    // anchor synchronously there so the first split setBounds frame is masked,
    // rather than waiting until the following animation frame.
    const handleRendererResize = () => {
      if (!plan) return;
      const current = currentBounds();
      plan.started = true;
      applyCompensation(current);
    };

    const sample = () => {
      frame = 0;
      if (!plan) return;
      if (performance.now() - plan.installedAt >= PLAN_SETTLE_TIMEOUT_MS) {
        plan = null;
        clearCompensation();
        return;
      }
      const current = currentBounds();
      if (!plan.started && differsFrom(current, plan.initial)) plan.started = true;

      if (plan.started) {
        applyCompensation(current);

        if (!differsFrom(current, plan.bounds)) {
          plan.stableFrames += 1;
          if (plan.stableFrames >= 2) {
            plan = null;
            clearCompensation();
            return;
          }
        } else {
          plan.stableFrames = 0;
        }
      }
      frame = requestAnimationFrame(sample);
    };

    const unsubscribe = window.electronAPI?.onMainWindowWillResize?.((resize) => {
      // A deliberate move invalidates a live plan's target bounds; drop the mask.
      if (resize?.anchor === "none") {
        plan = null;
        cancelAnimationFrame(frame);
        clearCompensation();
        return;
      }
      if (!resize?.bounds || !resize?.anchor) return;
      plan = {
        bounds: resize.bounds,
        anchor: resize.anchor,
        initial: currentBounds(),
        started: false,
        stableFrames: 0,
        installedAt: performance.now(),
      };
      cancelAnimationFrame(frame);
      clearCompensation();
      frame = requestAnimationFrame(sample);
      // The main process holds setBounds until the mask is armed; a fixed
      // delay on its side loses the race whenever this renderer is busy.
      if (resize.token !== undefined) {
        window.electronAPI?.ackMainWindowResizeMask?.(resize.token);
      }
    });
    window.addEventListener("resize", handleRendererResize);

    return () => {
      plan = null;
      cancelAnimationFrame(frame);
      clearCompensation();
      window.removeEventListener("resize", handleRendererResize);
      unsubscribe?.();
    };
  }, []);
}
