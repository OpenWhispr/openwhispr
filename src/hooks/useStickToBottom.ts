import {
  useCallback,
  useLayoutEffect,
  useRef,
  type RefObject,
  type TouchEvent,
  type WheelEvent,
} from "react";
import {
  createScrollFollowController,
  type ScrollFollowController,
} from "../utils/scrollFollowState";

// Passive scrolls within this distance still follow the stream. Explicit
// upward input stays detached until the reader reaches the true bottom.
const PIN_THRESHOLD_PX = 40;

interface StickToBottomOptions {
  /** While true the scroller resets to the top and re-pins (e.g. cleared content). */
  resetToTop?: boolean;
}

interface StickToBottomResult<T extends HTMLElement> {
  scrollRef: RefObject<T | null>;
  handleScroll: () => void;
  handleWheel: (event: WheelEvent<T>) => void;
  handleTouchStart: (event: TouchEvent<T>) => void;
  handleTouchMove: (event: TouchEvent<T>) => void;
  handleTouchEnd: () => void;
}

function pinToBottom(node: HTMLElement): void {
  const bottom = node.scrollHeight - node.clientHeight;
  if (bottom > 0 && Math.abs(node.scrollTop - bottom) > 1) node.scrollTop = bottom;
}

// Portaled descendants (e.g. a popover opened from a row) bubble synthetic
// events through the React tree while their DOM target lives outside the
// scroller; wheeling there scrolls another surface, not the stream.
function isReaderGesture(node: HTMLElement, target: EventTarget | null): boolean {
  return (
    node.scrollHeight - node.clientHeight > 1 && target instanceof Node && node.contains(target)
  );
}

/**
 * Keeps a scroller pinned to its bottom while content (`dep`) grows, but never
 * yanks a user back down after they scroll up to re-read. Attach the returned
 * ref and event handlers to the scrolling element.
 */
export function useStickToBottom<T extends HTMLElement>(
  dep: unknown,
  { resetToTop = false }: StickToBottomOptions = {}
): StickToBottomResult<T> {
  const scrollRef = useRef<T>(null);
  const followerRef = useRef<ScrollFollowController | null>(null);
  const touchYRef = useRef<number | null>(null);
  if (!followerRef.current) {
    followerRef.current = createScrollFollowController({
      nearBottomThreshold: PIN_THRESHOLD_PX,
    });
  }

  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (resetToTop) {
      followerRef.current?.follow();
      node.scrollTop = 0;
      return;
    }
    if (followerRef.current?.isFollowing()) pinToBottom(node);

    const content = node.firstElementChild;
    const ro = new ResizeObserver(() => {
      if (followerRef.current?.isFollowing()) pinToBottom(node);
    });
    ro.observe(node);
    if (content) ro.observe(content);
    return () => ro.disconnect();
  }, [dep, resetToTop]);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    followerRef.current?.update(node);
  }, []);

  const handleWheel = useCallback((event: WheelEvent<T>) => {
    const node = scrollRef.current;
    if (event.deltaY < 0 && node && isReaderGesture(node, event.target)) {
      followerRef.current?.leaveBottom();
    }
  }, []);

  const handleTouchStart = useCallback((event: TouchEvent<T>) => {
    touchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((event: TouchEvent<T>) => {
    const nextY = event.touches[0]?.clientY;
    const previousY = touchYRef.current;
    if (nextY == null) return;
    const node = scrollRef.current;
    if (previousY != null && nextY > previousY && node && isReaderGesture(node, event.target)) {
      followerRef.current?.leaveBottom();
    }
    touchYRef.current = nextY;
  }, []);

  const handleTouchEnd = useCallback(() => {
    touchYRef.current = null;
  }, []);

  return {
    scrollRef,
    handleScroll,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
}
