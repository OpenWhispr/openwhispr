import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

// Within this distance of the bottom the user counts as "following" the
// stream; programmatic scrolls re-run the handler and therefore re-pin.
const PIN_THRESHOLD_PX = 40;

interface StickToBottomOptions {
  /** While true the scroller resets to the top and re-pins (e.g. cleared content). */
  resetToTop?: boolean;
}

/**
 * Keeps a scroller pinned to its bottom while content (`dep`) grows, but never
 * yanks a user back down after they scroll up to re-read. Attach `scrollRef`
 * and `onScroll` to the scrolling element.
 */
export function useStickToBottom<T extends HTMLElement>(
  dep: unknown,
  { resetToTop = false }: StickToBottomOptions = {}
): { scrollRef: RefObject<T | null>; handleScroll: () => void } {
  const scrollRef = useRef<T>(null);
  const pinnedRef = useRef(true);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (resetToTop) {
      pinnedRef.current = true;
      node.scrollTop = 0;
      return;
    }
    if (pinnedRef.current) {
      const bottom = node.scrollHeight - node.clientHeight;
      if (bottom > 0 && Math.abs(node.scrollTop - bottom) > 1) node.scrollTop = bottom;
    }
    // Re-pin when content height settles late; re-attached per dep since the
    // content element can swap (empty state → list).
    const content = node.firstElementChild;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) node.scrollTop = node.scrollHeight - node.clientHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [dep, resetToTop]);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD_PX;
  }, []);

  return { scrollRef, handleScroll };
}
