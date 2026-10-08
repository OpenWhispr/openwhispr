import {
  createScrollFollowController,
  getScrollBottomDistance,
  type ScrollMetrics,
} from "../../utils/scrollFollowState";

// The bar's 28px below the panel, the open card's 8px overhang and a 4px gap.
const FLOATING_CHAT_INSET_EXTRA_PX = 40;
const FLOATING_CHAT_MIN_VISIBLE_CONTENT_PX = 80;

const SCROLL_BOTTOM_THRESHOLD_PX = 80;
const FLOATING_CHAT_TOP_CLEARANCE_PX =
  FLOATING_CHAT_MIN_VISIBLE_CONTENT_PX + FLOATING_CHAT_INSET_EXTRA_PX;

export type { ScrollMetrics };

interface ResizeObserverHandle {
  observe: (element: Element) => void;
  disconnect: () => void;
}

interface FloatingChatLayoutOptions {
  panel: HTMLElement;
  container: HTMLElement;
  contentRoot: HTMLElement;
  getActiveScroller: () => HTMLElement | null;
}

interface FloatingChatLayoutDependencies {
  createResizeObserver?: (callback: () => void) => ResizeObserverHandle;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (frameId: number) => void;
}

interface FloatingChatSizeOptions {
  panel: HTMLElement;
  container: HTMLElement;
}

/** The open chat grows to fit its content, up to three-quarters of the note view: room for the default / menu. */
export function observeFloatingChatMaxHeight(
  { panel, container }: FloatingChatSizeOptions,
  createResizeObserver: (callback: () => void) => ResizeObserverHandle = (callback) =>
    new ResizeObserver(callback)
): () => void {
  const updateHeight = (): void => {
    const availableHeight = Math.max(0, container.clientHeight - FLOATING_CHAT_TOP_CLEARANCE_PX);
    panel.style.maxHeight = `${Math.min((container.clientHeight * 3) / 4, availableHeight)}px`;
  };

  updateHeight();
  const observer = createResizeObserver(updateHeight);
  observer.observe(container);

  return (): void => observer.disconnect();
}

export function isNearScrollBottom(metrics: ScrollMetrics): boolean {
  return getScrollBottomDistance(metrics) <= SCROLL_BOTTOM_THRESHOLD_PX;
}

export function observeFloatingChatLayout(
  { panel, container, contentRoot, getActiveScroller }: FloatingChatLayoutOptions,
  dependencies: FloatingChatLayoutDependencies = {}
): () => void {
  const createResizeObserver =
    dependencies.createResizeObserver ??
    ((callback): ResizeObserverHandle => new ResizeObserver(callback));
  const requestFrame =
    dependencies.requestFrame ?? ((callback): number => requestAnimationFrame(callback));
  const cancelFrame =
    dependencies.cancelFrame ?? ((frameId): void => cancelAnimationFrame(frameId));
  const follower = createScrollFollowController({
    nearBottomThreshold: SCROLL_BOTTOM_THRESHOLD_PX,
  });
  // The chat opens over the note without scrolling it; the inset only makes room to
  // scroll the end into view, and a reader who does is followed from then on.
  follower.leaveBottom();
  let frameId: number | null = null;
  let touchY: number | null = null;

  const pinActiveScroller = (): void => {
    const scroller = getActiveScroller();
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    follower.follow();
  };

  const schedulePin = (): void => {
    if (!follower.isFollowing()) return;
    if (frameId !== null) cancelFrame(frameId);
    frameId = requestFrame((): void => {
      frameId = null;
      if (follower.isFollowing()) pinActiveScroller();
    });
  };

  const applyInset = (): void => {
    container.style.setProperty(
      "--floating-inset",
      `${panel.offsetHeight + FLOATING_CHAT_INSET_EXTRA_PX}px`
    );
    schedulePin();
  };

  const updateFollowState = (): void => {
    const scroller = getActiveScroller();
    if (scroller) follower.update(scroller);
  };

  // The capture listeners on the content root also see gestures over chrome
  // that never scrolls the active scroller (recording header).
  // A wheel there moves nothing, so no scroll event could ever rejoin follow
  // mode — only a gesture aimed at the scroller itself counts as leaving.
  const stopFollowing = (target: EventTarget | null): void => {
    const scroller = getActiveScroller();
    if (!scroller || scroller.scrollHeight - scroller.clientHeight <= 1) return;
    // Cast, not `instanceof Node`: this module runs under node:test, which has
    // no DOM globals; wheel/touch targets are always nodes in the renderer.
    if (target == null || !scroller.contains(target as Node)) return;
    follower.leaveBottom();
    if (frameId !== null) {
      cancelFrame(frameId);
      frameId = null;
    }
  };

  const handleWheel = (event: WheelEvent): void => {
    if (event.deltaY < 0) stopFollowing(event.target);
  };

  const handleTouchStart = (event: TouchEvent): void => {
    touchY = event.touches[0]?.clientY ?? null;
  };

  const handleTouchMove = (event: TouchEvent): void => {
    const nextY = event.touches[0]?.clientY;
    if (nextY == null) return;
    if (touchY != null && nextY > touchY) stopFollowing(event.target);
    touchY = nextY;
  };

  const handleTouchEnd = (): void => {
    touchY = null;
  };

  contentRoot.addEventListener("scroll", updateFollowState, true);
  contentRoot.addEventListener("wheel", handleWheel, { capture: true, passive: true });
  contentRoot.addEventListener("touchstart", handleTouchStart, { capture: true, passive: true });
  contentRoot.addEventListener("touchmove", handleTouchMove, { capture: true, passive: true });
  contentRoot.addEventListener("touchend", handleTouchEnd, { capture: true, passive: true });
  applyInset();

  const observer = createResizeObserver((): void => applyInset());
  observer.observe(panel);
  observer.observe(contentRoot);

  return (): void => {
    observer.disconnect();
    contentRoot.removeEventListener("scroll", updateFollowState, true);
    contentRoot.removeEventListener("wheel", handleWheel, true);
    contentRoot.removeEventListener("touchstart", handleTouchStart, true);
    contentRoot.removeEventListener("touchmove", handleTouchMove, true);
    contentRoot.removeEventListener("touchend", handleTouchEnd, true);
    if (frameId !== null) cancelFrame(frameId);
    container.style.removeProperty("--floating-inset");
  };
}
