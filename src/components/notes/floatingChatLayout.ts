export const FLOATING_CHAT_INSET_EXTRA_PX = 32;
export const FLOATING_CHAT_MIN_VISIBLE_CONTENT_PX = 80;
export const FLOATING_CHAT_MAX_HEIGHT_CSS = "calc(100% - 7rem)";

const SCROLL_BOTTOM_THRESHOLD_PX = 80;

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

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
  const distanceToBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
  return distanceToBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
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
  let followsBottom = true;
  let frameId: number | null = null;
  let forcePinPending = false;

  const pinActiveScroller = (): void => {
    const scroller = getActiveScroller();
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    followsBottom = true;
  };

  const schedulePin = (force: boolean): void => {
    forcePinPending ||= force;
    if (!forcePinPending && !followsBottom) return;
    if (frameId !== null) cancelFrame(frameId);
    frameId = requestFrame((): void => {
      frameId = null;
      const shouldForce = forcePinPending;
      forcePinPending = false;
      if (shouldForce || followsBottom) pinActiveScroller();
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
    followsBottom = scroller !== null && isNearScrollBottom(scroller);
  };

  contentRoot.addEventListener("scroll", updateFollowState, true);
  applyInset(true);

  const observer = createResizeObserver((): void => applyInset());
  observer.observe(panel);
  observer.observe(contentRoot);

  return (): void => {
    observer.disconnect();
    contentRoot.removeEventListener("scroll", updateFollowState, true);
    if (frameId !== null) cancelFrame(frameId);
    container.style.removeProperty("--floating-inset");
  };
}
