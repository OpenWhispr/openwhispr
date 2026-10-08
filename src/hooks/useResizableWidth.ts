import { useCallback, useRef, useState } from "react";

type PanelEdge = "start" | "end";

interface ResizableWidthOptions {
  storageKey: string;
  /** The panel's edge its handle sits on, the one facing the note. */
  edge: PanelEdge;
  min: number;
  max: number;
  /** A tighter cap for this drag, for a panel whose CSS cap depends on its surroundings. */
  getDragMax?: (panel: HTMLElement) => number;
}

/** Pointer travel before a press counts as a drag, so a click saves no width. */
const DRAG_SLOP_PX = 3;

/** The panel's width after the pointer moved `deltaX` pixels from where its drag started. */
export function resizedWidth(
  startWidth: number,
  deltaX: number,
  { edge, rtl, min, max }: { edge: PanelEdge; rtl: boolean; min: number; max: number }
): number {
  // Dragging an end edge toward the inline end widens the panel; a start edge, or a
  // right-to-left layout, flips which way that is on screen.
  const sign = (edge === "end" ? 1 : -1) * (rtl ? -1 : 1);
  return Math.min(max, Math.max(min, Math.round(startWidth + sign * deltaX)));
}

function readStoredWidth(storageKey: string, min: number, max: number): number | null {
  try {
    const stored = Number(localStorage.getItem(storageKey));
    return stored > 0 ? Math.min(max, Math.max(min, stored)) : null;
  } catch {
    return null;
  }
}

/**
 * A panel the user can widen or narrow by dragging a handle on one edge. The width is
 * remembered across launches; null until the panel has been resized once.
 */
export function useResizableWidth<T extends HTMLElement>({
  storageKey,
  edge,
  min,
  max,
  getDragMax,
}: ResizableWidthOptions) {
  const panelRef = useRef<T>(null);
  const [width, setWidth] = useState(() => readStoredWidth(storageKey, min, max));
  const [isResizing, setIsResizing] = useState(false);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      const panel = panelRef.current;
      if (event.button !== 0 || !panel) return;
      // Keeps the drag from selecting the note's text.
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const startX = event.clientX;
      const startWidth = panel.getBoundingClientRect().width;
      // Past the CSS cap the panel stops while the pointer goes on, so the drag is held to it.
      const dragMax = Math.max(min, Math.min(max, getDragMax?.(panel) ?? max));
      const options = { edge, rtl: getComputedStyle(panel).direction === "rtl", min, max: dragMax };
      // A click that never drags saves nothing, so the panel keeps its default width.
      let next: number | null = null;
      let ended = false;

      const move = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        if (next === null && Math.abs(deltaX) < DRAG_SLOP_PX) return;
        next = resizedWidth(startWidth, deltaX, options);
        setWidth(next);
      };
      const end = () => {
        // pointerup is followed by lostpointercapture, which also ends a drag the browser took away.
        if (ended) return;
        ended = true;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        handle.removeEventListener("lostpointercapture", end);
        setIsResizing(false);
        if (next === null) return;
        // What the panel shows, which a CSS cap (the docked chat's 70%) can hold below the drag.
        const settled = Math.round(panel.getBoundingClientRect().width);
        setWidth(settled);
        try {
          localStorage.setItem(storageKey, String(settled));
        } catch {
          // The width still applies until the app restarts.
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
      handle.addEventListener("lostpointercapture", end);
      setIsResizing(true);
    },
    [edge, getDragMax, max, min, storageKey]
  );

  return { panelRef, width, isResizing, startResize };
}
