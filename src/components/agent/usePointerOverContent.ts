import { useEffect, useRef } from "react";

// The transparent wrappers around what the agent window shows.
const TRANSPARENT_WRAPPERS = "html, body, #root, .agent-window, .agent-window-content";

/**
 * Tells main whether the pointer is over something the window shows: a call's pill that
 * keeps the transcript's window on macOS lets clicks through the rest. Checked again
 * whenever `arrangement` changes (another layout, or the window settled at a new size or
 * place), from where the pointer last was on screen, since it may not have moved.
 */
export function usePointerOverContent(enabled: boolean, arrangement: string) {
  const screenPointRef = useRef<{ x: number; y: number } | null>(null);
  const overRef = useRef<boolean | null>(null);
  const reportRef = useRef((target: Element | null) => {
    const over = target !== null && !target.matches(TRANSPARENT_WRAPPERS);
    if (over === overRef.current) return;
    overRef.current = over;
    window.electronAPI?.agentWindowSetPointerOverContent?.(over);
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const report = reportRef.current;
    const move = (event: MouseEvent) => {
      screenPointRef.current = { x: event.screenX, y: event.screenY };
      report(event.target as Element);
    };
    const leave = () => {
      screenPointRef.current = null;
      report(null);
    };
    document.addEventListener("mousemove", move);
    document.documentElement.addEventListener("mouseleave", leave);
    return () => {
      document.removeEventListener("mousemove", move);
      document.documentElement.removeEventListener("mouseleave", leave);
    };
  }, [enabled]);

  useEffect(() => {
    const point = screenPointRef.current;
    if (!enabled || !point) return;
    reportRef.current(
      document.elementFromPoint(point.x - window.screenX, point.y - window.screenY)
    );
  }, [enabled, arrangement]);
}
