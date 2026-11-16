import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentWindowLayout } from "../../types/electron";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

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
}: {
  visible: boolean;
  layout: AgentWindowLayout;
  focus: boolean;
  /** The standalone card's height; a change resizes the window without a fade. */
  contentHeight?: number;
  /** pill only: the wider pill that reads "Waiting for answer" or a notice; it widens in place. */
  wide?: boolean;
}) {
  const [shown, setShown] = useState(false);
  // The layout main last sized the window for; a hide shrinks it to the pill.
  const appliedLayoutRef = useRef<AgentWindowLayout>("pill");

  useEffect(() => {
    if (!visible) return undefined;
    let current = true;
    const widePill = layout === "pill" && wide;
    void (async () => {
      const resizes = appliedLayoutRef.current !== layout;
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
      });
      appliedLayoutRef.current = layout;
      if (resizes) {
        await resized;
        await nextFrame();
      }
      if (current) setShown(true);
    })();
    return () => {
      current = false;
    };
  }, [visible, layout, focus, contentHeight, wide]);

  // Close: transparent first, so the next show never paints this frame.
  const hide = useCallback(async () => {
    setShown(false);
    await nextFrame();
    await nextFrame();
    await window.electronAPI?.agentWindowHide?.();
    appliedLayoutRef.current = "pill";
  }, []);

  // Main already hid the window (onboarding took the screen).
  const forgetBounds = useCallback(() => {
    setShown(false);
    appliedLayoutRef.current = "pill";
  }, []);

  return { shown, hide, forgetBounds };
}
