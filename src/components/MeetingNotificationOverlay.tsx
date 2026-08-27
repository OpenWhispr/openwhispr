import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import type { MeetingNotificationData } from "../types/electron";
import { MeetingNotificationCard } from "./MeetingNotificationCard";
import {
  getMeetingNotificationPresentation,
  getMeetingNotificationSwipeOutcome,
  initializeMeetingNotificationOverlay,
  subscribeMeetingAutoEndCountdown,
} from "./meetingNotificationModel";

interface PointerSwipe {
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
  axis: "pending" | "horizontal" | "vertical";
}

interface WheelSwipe {
  offsetX: number;
  lastEventAt: number;
}

type SwipeExitDirection = "left" | "right";

const DEFAULT_CARD_WIDTH_PX = 368;
const SWIPE_AXIS_LOCK_PX = 6;
const WHEEL_SWIPE_IDLE_MS = 140;

export default function MeetingNotificationOverlay(): ReactElement {
  const { t } = useTranslation();
  const [data, setData] = useState<MeetingNotificationData | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [swipeOffsetX, setSwipeOffsetX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [exitDirection, setExitDirection] = useState<SwipeExitDirection>("right");
  const notificationRef = useRef<HTMLDivElement | null>(null);
  const pointerSwipeRef = useRef<PointerSwipe | null>(null);
  const wheelSwipeRef = useRef<WheelSwipe | null>(null);
  const wheelIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gestureActiveRef = useRef(false);
  const responseStartedRef = useRef(false);

  useEffect(() => {
    return initializeMeetingNotificationOverlay({
      subscribe: (callback) => window.electronAPI?.onMeetingNotificationData?.(callback),
      getPendingData: () =>
        window.electronAPI?.getMeetingNotificationData?.() ?? Promise.resolve(null),
      onData: setData,
      onVisible: () => setIsVisible(true),
      onReady: () => {
        void window.electronAPI?.meetingNotificationReady?.();
      },
    });
  }, []);

  useEffect(() => {
    if (data?.kind !== "auto-end") return;
    return subscribeMeetingAutoEndCountdown(data.expiresAt, setSecondsRemaining);
  }, [data]);

  useEffect(() => {
    return () => {
      if (wheelIdleTimerRef.current !== null) clearTimeout(wheelIdleTimerRef.current);
    };
  }, []);

  const presentation = getMeetingNotificationPresentation(data, secondsRemaining);

  const respond = useCallback(
    async (action: string, direction: SwipeExitDirection = "right"): Promise<void> => {
      if (data?.kind !== "detection" || responseStartedRef.current) return;
      responseStartedRef.current = true;
      setExitDirection(direction);
      setIsSwiping(false);
      setIsVisible(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      window.electronAPI?.meetingNotificationRespond?.(data.detectionId, action);
    },
    [data]
  );

  const keepRecording = useCallback(() => {
    if (data?.kind !== "auto-end") return;
    void window.electronAPI?.meetingAutoEndKeep?.(data.sessionId);
  }, [data]);

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
    window.electronAPI?.setNotificationInteractivity?.(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    if (gestureActiveRef.current || pointerSwipeRef.current !== null) return;
    window.electronAPI?.setNotificationInteractivity?.(false);
  }, []);

  const finishSwipe = useCallback(
    (horizontalDelta: number, verticalDelta: number, horizontalVelocity: number): void => {
      if (wheelIdleTimerRef.current !== null) {
        clearTimeout(wheelIdleTimerRef.current);
        wheelIdleTimerRef.current = null;
      }
      wheelSwipeRef.current = null;
      gestureActiveRef.current = false;

      const outcome = getMeetingNotificationSwipeOutcome({
        dismissible: presentation.dismissible,
        horizontalDelta,
        verticalDelta,
        horizontalVelocity,
        cardWidth: notificationRef.current?.offsetWidth ?? DEFAULT_CARD_WIDTH_PX,
      });

      if (outcome === "dismiss") {
        void respond("dismiss", horizontalDelta < 0 ? "left" : "right");
        return;
      }

      setIsSwiping(false);
      setSwipeOffsetX(0);
      if (!notificationRef.current?.matches(":hover")) {
        window.electronAPI?.setNotificationInteractivity?.(false);
      }
    },
    [presentation.dismissible, respond]
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (
        !presentation.dismissible ||
        !isVisible ||
        responseStartedRef.current ||
        !event.isPrimary ||
        event.button !== 0 ||
        (event.target instanceof Element && event.target.closest("button"))
      ) {
        return;
      }

      if (wheelIdleTimerRef.current !== null) {
        clearTimeout(wheelIdleTimerRef.current);
        wheelIdleTimerRef.current = null;
      }
      wheelSwipeRef.current = null;
      pointerSwipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: event.timeStamp,
        axis: "pending",
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [isVisible, presentation.dismissible]
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const swipe = pointerSwipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;

    const horizontalDelta = event.clientX - swipe.startX;
    const verticalDelta = event.clientY - swipe.startY;
    if (
      swipe.axis === "pending" &&
      Math.max(Math.abs(horizontalDelta), Math.abs(verticalDelta)) >= SWIPE_AXIS_LOCK_PX
    ) {
      swipe.axis = Math.abs(horizontalDelta) > Math.abs(verticalDelta) ? "horizontal" : "vertical";
    }
    if (swipe.axis !== "horizontal") return;

    event.preventDefault();
    gestureActiveRef.current = true;
    setIsSwiping(true);
    const cardWidth = notificationRef.current?.offsetWidth ?? DEFAULT_CARD_WIDTH_PX;
    setSwipeOffsetX(Math.max(-cardWidth, Math.min(cardWidth, horizontalDelta)));
  }, []);

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const swipe = pointerSwipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;

      pointerSwipeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      const horizontalDelta = event.clientX - swipe.startX;
      const verticalDelta = event.clientY - swipe.startY;
      const elapsedMs = Math.max(1, event.timeStamp - swipe.startedAt);
      finishSwipe(horizontalDelta, verticalDelta, horizontalDelta / elapsedMs);
    },
    [finishSwipe]
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (pointerSwipeRef.current?.pointerId !== event.pointerId) return;
      pointerSwipeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      finishSwipe(0, 0, 0);
    },
    [finishSwipe]
  );

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>): void => {
      if (
        !presentation.dismissible ||
        !isVisible ||
        responseStartedRef.current ||
        Math.abs(event.deltaX) <= Math.abs(event.deltaY)
      ) {
        return;
      }

      const previous = wheelSwipeRef.current;
      const eventGapMs = previous ? event.timeStamp - previous.lastEventAt : Infinity;
      const previousOffset = eventGapMs <= WHEEL_SWIPE_IDLE_MS ? (previous?.offsetX ?? 0) : 0;
      const cardWidth = notificationRef.current?.offsetWidth ?? DEFAULT_CARD_WIDTH_PX;
      // Wheel deltas describe content scrolling, so invert them to keep the card under the finger.
      const nextOffset = Math.max(-cardWidth, Math.min(cardWidth, previousOffset - event.deltaX));
      const sampleDurationMs = Number.isFinite(eventGapMs) ? Math.max(1, eventGapMs) : 16;
      const horizontalVelocity = (nextOffset - previousOffset) / sampleDurationMs;

      wheelSwipeRef.current = { offsetX: nextOffset, lastEventAt: event.timeStamp };
      gestureActiveRef.current = true;
      setIsSwiping(true);
      setSwipeOffsetX(nextOffset);

      const outcome = getMeetingNotificationSwipeOutcome({
        dismissible: true,
        horizontalDelta: nextOffset,
        verticalDelta: 0,
        horizontalVelocity,
        cardWidth,
      });
      if (outcome === "dismiss") {
        finishSwipe(nextOffset, 0, horizontalVelocity);
        return;
      }

      if (wheelIdleTimerRef.current !== null) clearTimeout(wheelIdleTimerRef.current);
      wheelIdleTimerRef.current = setTimeout(() => {
        finishSwipe(nextOffset, 0, 0);
      }, WHEEL_SWIPE_IDLE_MS);
    },
    [finishSwipe, isVisible, presentation.dismissible]
  );

  const title = "title" in presentation ? presentation.title : t(presentation.titleKey);
  const body =
    "bodyValues" in presentation
      ? t(presentation.bodyKey, presentation.bodyValues)
      : t(presentation.bodyKey);
  const handleAction =
    presentation.action === "keep" ? keepRecording : () => respond(presentation.action);
  const cardWidth = notificationRef.current?.offsetWidth ?? DEFAULT_CARD_WIDTH_PX;
  const swipeOpacity = Math.max(0.72, 1 - Math.abs(swipeOffsetX) / cardWidth / 2);
  const translateX = isVisible ? `${swipeOffsetX}px` : exitDirection === "left" ? "-120%" : "120%";
  const motionStyle: CSSProperties = {
    opacity: isVisible ? swipeOpacity : 0,
    transform: `translateX(${translateX}) scale(${isVisible ? 1 : 0.95})`,
    transition: isSwiping ? "none" : "transform 300ms ease-out, opacity 300ms ease-out",
    touchAction: presentation.dismissible ? "pan-y" : "auto",
  };

  return (
    <div className="meeting-notification-window w-full h-full bg-transparent p-3">
      <div
        ref={notificationRef}
        style={motionStyle}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onWheel={handleWheel}
      >
        <MeetingNotificationCard
          title={title}
          body={body}
          startLabel={t(presentation.actionKey)}
          onStart={handleAction}
          onDismiss={presentation.dismissible ? () => respond("dismiss") : undefined}
          closeVisible={isHovered}
          allowTitleWrap={presentation.allowTitleWrap}
        />
      </div>
    </div>
  );
}
