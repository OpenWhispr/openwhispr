import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentWindowLayout } from "../../types/electron";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

// The window size a layout takes: on macOS a call's pill keeps the transcript's window
// (agentWindowManager), so Expand and Minimize in a call resize nothing.
const windowSize = (
  layout: AgentWindowLayout,
  call: boolean,
  callKeepsTranscriptWindow: boolean
) =>
  call && layout === "pill" && callKeepsTranscriptWindow
    ? "modal"
    : call
      ? `call-${layout}`
      : layout;

// A resize that changes nothing fires no event; don't wait on it for long.
const RESIZE_WAIT_MS = 120;
const waitForResize = () =>
  new Promise<void>((resolve) => {
    const done = () => {
      window.removeEventListener("resize", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, RESIZE_WAIT_MS);
    window.addEventListener("resize", done);
  });

/**
 * Keeps the native window the size of the layout it shows, and gives it the
 * keyboard while the user types. A transparent window paints one stale frame
 * when it resizes, which no mask can hide, so the content goes fully
 * transparent first: two frames to reach the compositor, the resize, a frame
 * at the new size, then it fades back in (`shown`).
 */
export function useAgentSurface({
  visible,
  layout,
  focus,
  contentHeight,
  wide = false,
  call = false,
  callKeepsTranscriptWindow = false,
}: {
  visible: boolean;
  layout: AgentWindowLayout;
  focus: boolean;
  /** The standalone card's height; a change resizes the window without a fade. */
  contentHeight?: number;
  /** pill only: the wider pill that reads "Waiting for answer" or a notice; it widens in place. */
  wide?: boolean;
  /** A voice call's layouts: its taller pill, with cards above it. */
  call?: boolean;
  /** macOS: a call's pill keeps the transcript's window. */
  callKeepsTranscriptWindow?: boolean;
}) {
  const [shown, setShown] = useState(false);
  // The size main last gave the window; a hide shrinks it to the pill.
  const appliedSizeRef = useRef("pill");
  const size = windowSize(layout, call, callKeepsTranscriptWindow);

  useEffect(() => {
    if (!visible) return undefined;
    let current = true;
    const widePill = layout === "pill" && wide;
    void (async () => {
      const resizes = appliedSizeRef.current !== size;
      if (resizes) {
        setShown(false);
        await nextFrame();
        await nextFrame();
      } else {
        // An in-place change (the pill widening, a card's height) waits a frame,
        // so a layout change made in the same moment replaces it unseen.
        await nextFrame();
      }
      if (!current) return;
      const resized = waitForResize();
      await window.electronAPI?.agentWindowSetLayout?.({
        layout,
        focus,
        ...(contentHeight !== undefined ? { contentHeight } : {}),
        ...(widePill ? { wide: true } : {}),
        ...(call ? { call: true } : {}),
      });
      appliedSizeRef.current = size;
      if (resizes) {
        await resized;
        await nextFrame();
      }
      if (current) setShown(true);
    })();
    return () => {
      current = false;
    };
  }, [visible, layout, focus, contentHeight, wide, call, size]);

  // Close: transparent first, so the next show never paints this frame.
  const hide = useCallback(async () => {
    setShown(false);
    await nextFrame();
    await nextFrame();
    await window.electronAPI?.agentWindowHide?.();
    appliedSizeRef.current = "pill";
  }, []);

  // Main already hid the window (onboarding took the screen).
  const forgetBounds = useCallback(() => {
    setShown(false);
    appliedSizeRef.current = "pill";
  }, []);

  // Hidden in the very render whose layout the window isn't sized for yet, so no
  // frame shows it at the old size, whatever set the layout.
  return { shown: shown && appliedSizeRef.current === size, hide, forgetBounds };
}
