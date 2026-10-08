import { useCallback, useRef, useState } from "react";

type PanelEdge = "start" | "end";

interface ResizableWidthOptions {
  storageKey: string;
  /** The panel's edge its handle sits on, the one facing the note. */
  edge: PanelEdge;
  min: number;
  max: number;
}

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
      const options = { edge, rtl: getComputedStyle(panel).direction === "rtl", min, max };
      // A click that never moves saves nothing, so the panel keeps its default width.
      let next: number | null = null;

      const move = (moveEvent: PointerEvent) => {
        next = resizedWidth(startWidth, moveEvent.clientX - startX, options);
        setWidth(next);
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        setIsResizing(false);
        if (next === null) return;
        try {
          localStorage.setItem(storageKey, String(next));
        } catch {
          // The width still applies until the app restarts.
        }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
      setIsResizing(true);
    },
    [edge, max, min, storageKey]
  );

  return { panelRef, width, isResizing, startResize };
}
