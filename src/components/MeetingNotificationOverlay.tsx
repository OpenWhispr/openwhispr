import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type { MeetingAutoEndAction, MeetingNotificationData } from "../types/electron";
import { MeetingNotificationCard } from "./MeetingNotificationCard";
import {
  getMeetingNotificationPresentation,
  initializeMeetingNotificationOverlay,
  shouldDismissMeetingNotificationSwipe,
  shouldRestoreAutoEndCard,
  subscribeMeetingAutoEndCountdown,
} from "./meetingNotificationModel";

interface PointerSwipe {
  pointerId: number;
  startX: number;
}

// Distance over which a dragged card fades to its minimum opacity.
const SWIPE_FADE_DISTANCE_PX = 240;
const SWIPE_MIN_OPACITY = 0.4;

export default function MeetingNotificationOverlay(): ReactElement {
  const { t } = useTranslation();
  const [data, setData] = useState<MeetingNotificationData | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  // Live pointer offset while swiping; null when the card is at rest.
  const [dragX, setDragX] = useState<number | null>(null);
  // Which edge the card leaves through: +1 right (also the enter side), -1 left.
  const [exitDirection, setExitDirection] = useState<1 | -1>(1);
  const pointerSwipeRef = useRef<PointerSwipe | null>(null);

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

  const presentation = getMeetingNotificationPresentation(data, secondsRemaining);

  const respond = useCallback(
    async (action: string): Promise<void> => {
      if (data?.kind !== "detection") return;
      setIsVisible(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      window.electronAPI?.meetingNotificationRespond?.(data.detectionId, action);
    },
    [data]
  );

  const respondToAutoEnd = useCallback(
    async (action: MeetingAutoEndAction): Promise<void> => {
      if (data?.kind !== "auto-end") return;
      setIsVisible(false);
      // Main closes this window when it accepts the response. Anything else —
      // a rejection, a throw, a preload without the method — leaves it open, so
      // put the card back instead of stranding an invisible, unclickable
      // always-on-top overlay.
      try {
        const result = await window.electronAPI?.meetingAutoEndRespond?.(data.sessionId, action);
        if (shouldRestoreAutoEndCard(result)) setIsVisible(true);
      } catch {
        setIsVisible(true);
      }
    },
    [data]
  );

  const dismiss = useCallback((): void => {
    if (data?.kind === "auto-end") void respondToAutoEnd("dismiss");
    else void respond("dismiss");
  }, [data, respond, respondToAutoEnd]);

  const handleMouseEnter = useCallback((): void => {
    setIsHovered(true);
    window.electronAPI?.setNotificationInteractivity?.(true);
  }, []);

  const handleMouseLeave = useCallback((): void => {
    setIsHovered(false);
    // A captured pointer keeps dragging outside the card, so the window has to
    // stay interactive until the swipe finishes.
    if (pointerSwipeRef.current) return;
    window.electronAPI?.setNotificationInteractivity?.(false);
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (
        !presentation.dismissible ||
        !isVisible ||
        !event.isPrimary ||
        event.button !== 0 ||
        (event.target instanceof Element && event.target.closest("button"))
      ) {
        return;
      }

      pointerSwipeRef.current = { pointerId: event.pointerId, startX: event.clientX };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [isVisible, presentation.dismissible]
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    const swipe = pointerSwipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    setDragX(event.clientX - swipe.startX);
  }, []);

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const swipe = pointerSwipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;

      pointerSwipeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const distance = event.clientX - swipe.startX;
      // Releasing dragX re-enables the transition, so the card either springs
      // back to rest or continues off-screen the way it was already moving.
      setDragX(null);

      // The card may have been replaced mid-drag, so the dismissibility of the
      // card being released is what decides, not the one the swipe started on.
      if (shouldDismissMeetingNotificationSwipe(presentation.dismissible, distance)) {
        setExitDirection(distance < 0 ? -1 : 1);
        dismiss();
      } else if (!isHovered) {
        window.electronAPI?.setNotificationInteractivity?.(false);
      }
    },
    [dismiss, isHovered, presentation.dismissible]
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (pointerSwipeRef.current?.pointerId !== event.pointerId) return;
      pointerSwipeRef.current = null;
      setDragX(null);
      if (!isHovered) window.electronAPI?.setNotificationInteractivity?.(false);
    },
    [isHovered]
  );

  const title = "title" in presentation ? presentation.title : t(presentation.titleKey);
  const body =
    "bodyValues" in presentation
      ? t(presentation.bodyKey, presentation.bodyValues)
      : t(presentation.bodyKey);
  const handleAction =
    presentation.action === "restart"
      ? () => void respondToAutoEnd("restart")
      : () => respond(presentation.action);
  const secondaryActionKey =
    presentation.action === "restart" ? presentation.secondaryActionKey : undefined;

  const isDragging = dragX !== null;
  const motionStyle: CSSProperties = isDragging
    ? {
        transform: `translateX(${dragX}px)`,
        opacity: Math.max(
          SWIPE_MIN_OPACITY,
          1 - (Math.abs(dragX) / SWIPE_FADE_DISTANCE_PX) * (1 - SWIPE_MIN_OPACITY)
        ),
      }
    : isVisible
      ? { transform: "translateX(0) scale(1)", opacity: 1 }
      : { transform: `translateX(${exitDirection * 120}%) scale(0.95)`, opacity: 0 };

  return (
    <div
      className="meeting-notification-window w-full h-full bg-transparent p-3 select-none"
      style={{ touchAction: presentation.dismissible ? "pan-y" : "auto" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div
        className={[
          "will-change-transform",
          isDragging ? "" : "transition-[transform,opacity] duration-300 ease-out",
        ].join(" ")}
        style={motionStyle}
      >
        <MeetingNotificationCard
          title={title}
          body={body}
          startLabel={t(presentation.actionKey)}
          onStart={handleAction}
          secondaryLabel={secondaryActionKey ? t(secondaryActionKey) : undefined}
          onSecondary={secondaryActionKey ? () => void respondToAutoEnd("summary") : undefined}
          onDismiss={presentation.dismissible ? dismiss : undefined}
          closeVisible={isHovered}
          allowTitleWrap={presentation.allowTitleWrap}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
        />
      </div>
    </div>
  );
}
