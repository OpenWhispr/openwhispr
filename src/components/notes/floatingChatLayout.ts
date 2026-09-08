import {
  createScrollFollowController,
  getScrollBottomDistance,
  type ScrollMetrics,
} from "../../utils/scrollFollowState";

export const FLOATING_CHAT_INSET_EXTRA_PX = 32;
export const FLOATING_CHAT_MIN_VISIBLE_CONTENT_PX = 80;
export const FLOATING_CHAT_MAX_HEIGHT_CSS = "calc(100% - 7rem)";

const SCROLL_BOTTOM_THRESHOLD_PX = 80;

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
  let frameId: number | null = null;
  let forcePinPending = false;
  let touchY: number | null = null;

  const pinActiveScroller = (): void => {
    const scroller = getActiveScroller();
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    follower.follow();
  };

  const schedulePin = (force: boolean): void => {
    forcePinPending ||= force;
    if (!forcePinPending && !follower.isFollowing()) return;
    if (frameId !== null) cancelFrame(frameId);
    frameId = requestFrame((): void => {
      frameId = null;
      const shouldForce = forcePinPending;
      forcePinPending = false;
      if (shouldForce || follower.isFollowing()) pinActiveScroller();
    });
  };

  const applyInset = (force = false): void => {
    container.style.setProperty(
      "--floating-inset",
      `${panel.offsetHeight + FLOATING_CHAT_INSET_EXTRA_PX}px`
    );
    schedulePin(force);
  };

  const updateFollowState = (): void => {
    const scroller = getActiveScroller();
    if (scroller) follower.update(scroller);
  };

  // The capture listeners on the content root also see gestures over chrome
  // that never scrolls the active scroller (consent strip, recording header).
  // A wheel there moves nothing, so no scroll event could ever rejoin follow
  // mode — only a gesture aimed at the scroller itself counts as leaving.
  const stopFollowing = (target: EventTarget | null): void => {
    const scroller = getActiveScroller();
    if (!scroller || scroller.scrollHeight - scroller.clientHeight <= 1) return;
    // Cast, not `instanceof Node`: this module runs under node:test, which has
    // no DOM globals; wheel/touch targets are always nodes in the renderer.
    if (target == null || !scroller.contains(target as Node)) return;
    follower.leaveBottom();
    forcePinPending = false;
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
  applyInset(true);

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
