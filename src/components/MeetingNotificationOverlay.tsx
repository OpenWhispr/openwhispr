import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { MeetingNotificationCard } from "./MeetingNotificationCard";

type PromptVariant = "detected" | "starting" | "underway" | "ending";

interface NotificationData {
  detectionId: string;
  source: string;
  key: string;
  event: { summary?: string | null } | null;
  variant: PromptVariant;
  joinUrl: string | null;
  appName?: string | null;
  countdownMs?: number;
}

// Mirrors MIN_RESUME_MS in notificationTimer.js: main re-arms a resumed
// countdown with at least this much runway, so the displayed number must too.
const MIN_RESUME_SECONDS = 5;

export default function MeetingNotificationOverlay() {
  const { t } = useTranslation();
  const [data, setData] = useState<NotificationData | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);

  useEffect(() => {
    let shown = false;

    const show = (d: NotificationData) => {
      if (shown) return;
      shown = true;
      setData(d);
      if (d.variant === "ending" && typeof d.countdownMs === "number") {
        setCountdownSeconds(Math.round(d.countdownMs / 1000));
      }
      setTimeout(() => {
        setIsVisible(true);
        window.electronAPI?.meetingNotificationReady?.();
      }, 50);
    };

    const cleanup = window.electronAPI?.onMeetingNotificationData?.((incoming: NotificationData) =>
      show(incoming)
    );

    window.electronAPI?.getMeetingNotificationData?.().then((pulled: NotificationData | null) => {
      if (pulled) show(pulled);
    });

    return () => cleanup?.();
  }, []);

  // Cosmetic 1Hz countdown for the auto-stop card; the authoritative timer
  // lives in main's NotificationDismissTimer, which pauses while hovered.
  const countdownActive = countdownSeconds !== null;
  useEffect(() => {
    if (!countdownActive || isHovered || !isVisible) return;
    const timer = setInterval(() => {
      setCountdownSeconds((s) => (s === null ? null : Math.max(0, s - 1)));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdownActive, isHovered, isVisible]);

  const respond = useCallback(
    async (action: string) => {
      if (!data) return;
      setIsVisible(false);
      await new Promise((r) => setTimeout(r, 200));
      window.electronAPI?.meetingNotificationRespond?.(data.detectionId, action);
    },
    [data]
  );

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
    window.electronAPI?.setNotificationInteractivity?.(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    // Main resumes with at least MIN_RESUME_MS on the clock.
    setCountdownSeconds((s) => (s === null ? null : Math.max(s, MIN_RESUME_SECONDS)));
    window.electronAPI?.setNotificationInteractivity?.(false);
  }, []);

  const variant: PromptVariant = data?.variant ?? "detected";
  const isEnding = variant === "ending";
  const title = isEnding
    ? data?.appName
      ? t("meetingNotification.autoStop.titleProcessExit", { appName: data.appName })
      : t("meetingNotification.autoStop.titleSilence")
    : (variant !== "detected" && data?.event?.summary) || t("meetingNotification.title");
  const body = isEnding
    ? t("meetingNotification.autoStop.body", { seconds: countdownSeconds ?? 0 })
    : t(`meetingNotification.body.${variant}`);
  const startLabel = isEnding
    ? t("meetingNotification.autoStop.keep")
    : data?.joinUrl
      ? t("meetingNotification.join")
      : t("meetingNotification.start");

  return (
    <div className="meeting-notification-window w-full h-full bg-transparent p-3">
      <MeetingNotificationCard
        title={title}
        body={body}
        startLabel={startLabel}
        onStart={() => respond(isEnding ? "keep" : data?.joinUrl ? "join" : "start")}
        secondaryLabel={isEnding ? t("meetingNotification.autoStop.stopNow") : undefined}
        onSecondary={isEnding ? () => respond("stop") : undefined}
        onDismiss={() => respond("dismiss")}
        closeVisible={isHovered}
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
