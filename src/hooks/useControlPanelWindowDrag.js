import { useEffect } from "react";

// Matches OnboardingShell's 48px drag strip — the frameless window's titlebar.
const DRAG_STRIP_HEIGHT_PX = 48;
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
 * Manual titlebar drag for the control panel window. The window is
 * transparent on macOS, where Electron ignores `-webkit-app-region: drag`
 * entirely (and the hiddenInset titlebar's native drag with it), so
 * onboarding and the panel had no way to move the window. A mousedown in the
 * top strip that isn't aimed at an interactive control moves the native
 * window through the shared DragManager. Where app-region does work (the
 * opaque Windows/Linux window's onboarding strip), the system consumes the
 * mousedown before it reaches the DOM and this hook stays idle.
 */
export function useControlPanelWindowDrag(enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const api = window.electronAPI;
    if (!api?.startControlPanelDrag) return undefined;

    let dragging = false;
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      void api.stopControlPanelDrag?.();
    };
    const onMouseDown = (event) => {
      if (event.button !== 0 || event.clientY > DRAG_STRIP_HEIGHT_PX) return;
      if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return;
      dragging = true;
      void api.startControlPanelDrag();
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", stop);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("blur", stop);
    };
  }, [enabled]);
}
