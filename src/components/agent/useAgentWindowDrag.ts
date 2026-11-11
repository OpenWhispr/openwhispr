import { useCallback, useEffect, useRef, type PointerEvent } from "react";

/** Manual dragging for the assistant's transparent window, from its header or pill. */
export function useAgentWindowDrag() {
  const drag = useRef<{ x: number; y: number; started: boolean } | null>(null);
  const stopDragging = useCallback(() => {
    if (drag.current?.started) window.electronAPI?.agentWindowSetDragging?.(false);
    drag.current = null;
  }, []);

  useEffect(() => {
    window.addEventListener("blur", stopDragging);
    return () => {
      stopDragging();
      window.removeEventListener("blur", stopDragging);
    };
  }, [stopDragging]);

  return {
    onPointerDown(event: PointerEvent<HTMLElement>) {
      const target = event.target as Element;
      if (event.button !== 0 || !event.currentTarget.contains(target) || target.closest("button"))
        return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, started: false };
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const origin = drag.current;
      if (!origin || origin.started) return;
      if (event.buttons === 0) return stopDragging();
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 3) return;
      origin.started = true;
      window.electronAPI?.agentWindowSetDragging?.(true);
    },
    onPointerUp: stopDragging,
    onPointerCancel: stopDragging,
    onLostPointerCapture: stopDragging,
  };
}
