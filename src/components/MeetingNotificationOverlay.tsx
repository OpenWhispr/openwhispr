import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import type { MeetingNotificationData } from "../types/electron";
import { MeetingNotificationCard } from "./MeetingNotificationCard";
import {
  getMeetingNotificationPresentation,
  initializeMeetingNotificationOverlay,
  shouldDismissMeetingNotificationSwipe,
  subscribeMeetingAutoEndCountdown,
} from "./meetingNotificationModel";

interface PointerSwipe {
  pointerId: number;
  startX: number;
}

export default function MeetingNotificationOverlay(): ReactElement {
  const { t } = useTranslation();
  const [data, setData] = useState<MeetingNotificationData | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
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

  const keepRecording = useCallback((): void => {
    if (data?.kind !== "auto-end") return;
    void window.electronAPI?.meetingAutoEndKeep?.(data.sessionId);
  }, [data]);

  const handleMouseEnter = useCallback((): void => {
    setIsHovered(true);
    window.electronAPI?.setNotificationInteractivity?.(true);
  }, []);

  const handleMouseLeave = useCallback((): void => {
    setIsHovered(false);
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

      pointerSwipeRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [isVisible, presentation.dismissible]
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const swipe = pointerSwipeRef.current;
      if (!swipe || swipe.pointerId !== event.pointerId) return;

      pointerSwipeRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (
        shouldDismissMeetingNotificationSwipe(
          presentation.dismissible,
          event.clientX - swipe.startX
        )
      ) {
        void respond("dismiss");
      } else if (!isHovered) {
        window.electronAPI?.setNotificationInteractivity?.(false);
      }
    },
    [isHovered, presentation.dismissible, respond]
  );

  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (pointerSwipeRef.current?.pointerId !== event.pointerId) return;
      pointerSwipeRef.current = null;
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
    presentation.action === "keep" ? keepRecording : () => respond(presentation.action);

  return (
    <div
      className="meeting-notification-window w-full h-full bg-transparent p-3"
      style={{ touchAction: presentation.dismissible ? "pan-y" : "auto" }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <MeetingNotificationCard
        title={title}
        body={body}
        startLabel={t(presentation.actionKey)}
        onStart={handleAction}
        onDismiss={presentation.dismissible ? () => respond("dismiss") : undefined}
        closeVisible={isHovered}
        allowTitleWrap={presentation.allowTitleWrap}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={[
          "transition-all duration-300 ease-out",
          isVisible
            ? "translate-x-0 opacity-100 scale-100"
            : "translate-x-[120%] opacity-0 scale-95",
        ].join(" ")}
      />
    </div>
  );
}
