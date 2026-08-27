import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { MeetingNotificationData } from "../types/electron";
import { MeetingNotificationCard } from "./MeetingNotificationCard";
import {
  getMeetingNotificationPresentation,
  initializeMeetingNotificationOverlay,
  subscribeMeetingAutoEndCountdown,
} from "./meetingNotificationModel";

export default function MeetingNotificationOverlay() {
  const { t } = useTranslation();
  const [data, setData] = useState<MeetingNotificationData | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(0);

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

  const respond = useCallback(
    async (action: string) => {
      if (data?.kind !== "detection") return;
      setIsVisible(false);
      await new Promise((r) => setTimeout(r, 200));
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
    window.electronAPI?.setNotificationInteractivity?.(false);
  }, []);

  const presentation = getMeetingNotificationPresentation(data, secondsRemaining);
  const title = "title" in presentation ? presentation.title : t(presentation.titleKey);
  const body =
    "bodyValues" in presentation
      ? t(presentation.bodyKey, presentation.bodyValues)
      : t(presentation.bodyKey);
  const handleAction =
    presentation.action === "keep" ? keepRecording : () => respond(presentation.action);

  return (
    <div className="meeting-notification-window w-full h-full bg-transparent p-3">
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
