import { useEffect } from "react";
import { getCachedPlatform } from "../utils/platform";

// Matches OnboardingShell's 48px drag strip — the frameless window's titlebar.
const DRAG_STRIP_HEIGHT_PX = 48;
// A press has to travel before it becomes a drag. Without this, a plain click
// on the titlebar starts a tracked drag whose first tick runs the DragManager's
// clampToWorkArea — snapping a window the user had parked past a screen edge.
const DRAG_START_THRESHOLD_PX = 3;
// A mousedown aimed at a control in the band must win over the drag.
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='combobox']",
  "[contenteditable='true']",
  "[data-no-window-drag]",
].join(", ");

/**
 * Manual titlebar drag for the control panel window, macOS only. That window
 * is transparent there (for the compact onboarding frame's rounded corners),
 * and Electron ignores `-webkit-app-region: drag` entirely on a transparent
 * window — the hiddenInset titlebar's native drag dies with it, leaving
 * onboarding and the panel with no way to move the window. Windows/Linux keep
 * an opaque window where app-region works, so the fallback stays off there
 * rather than second-guessing the real drag regions (its 48px band would
 * overshoot ControlPanel's own 40px strips).
 *
 * A press in the top strip that isn't aimed at an interactive control, once it
 * travels past the threshold, moves the native window through the shared
 * DragManager.
 */
export function useControlPanelWindowDrag(enabled) {
  useEffect(() => {
    if (!enabled || getCachedPlatform() !== "darwin") return undefined;
    const api = window.electronAPI;
    if (!api?.startControlPanelDrag) return undefined;

    let origin = null;
    let dragging = false;
    const stop = () => {
      origin = null;
      if (!dragging) return;
      dragging = false;
      void api.stopControlPanelDrag?.();
    };
    const onMouseDown = (event) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      // The universal titlebar band, plus any surface that declares itself
      // window chrome (e.g. the compact onboarding hero via
      // data-window-drag-zone in OnboardingShell).
      const inDragZone =
        event.clientY <= DRAG_STRIP_HEIGHT_PX ||
        Boolean(target?.closest("[data-window-drag-zone]"));
      if (!inDragZone) return;
      if (target?.closest(INTERACTIVE_SELECTOR)) return;
      origin = { x: event.clientX, y: event.clientY };
    };
    const onMouseMove = (event) => {
      if (!origin || dragging) return;
      if (
        Math.abs(event.clientX - origin.x) < DRAG_START_THRESHOLD_PX &&
        Math.abs(event.clientY - origin.y) < DRAG_START_THRESHOLD_PX
      ) {
        return;
      }
      // DragManager captures its cursor-to-window offset when it starts, so
      // beginning here rather than at mousedown costs no fidelity — the window
      // picks up exactly under the cursor.
      dragging = true;
      void api.startControlPanelDrag();
    };
    // Capture phase: a step's own mousedown handling must not be able to
    // swallow the titlebar gesture before it reaches this window listener.
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [enabled]);
}
