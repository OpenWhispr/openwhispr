import { useState, useEffect, useCallback } from "react";
import { MeetingNotificationCard } from "./MeetingNotificationCard";

interface NotificationData {
  detectionId: string;
  source: string;
  key: string;
  title: string;
  body: string;
  event: any;
  joinUrl?: string | null;
}

export default function MeetingNotificationOverlay() {
  const [data, setData] = useState<NotificationData | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    let shown = false;

    const show = (d: NotificationData) => {
      if (shown) return;
      shown = true;
      setData(d);
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

  const respond = useCallback(
    async (action: string) => {
      if (!data) return;
      setIsVisible(false);
      await new Promise((r) => setTimeout(r, 200));
      window.electronAPI?.meetingNotificationRespond?.(data.detectionId, action);
    },
    [data]
  );

  // The overlay window is interactive by default (see windowManager
  // showMeetingNotification), so hover is only used to reveal the dismiss "X".
  // We no longer toggle click-through on hover — that made the "Start Recording"
  // CTA unreliable on macOS.
  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
  }, []);

  return (
    <div className="meeting-notification-window w-full h-full bg-transparent p-3">
      <MeetingNotificationCard
        title={data?.title ?? "Meeting Detected"}
        body={data?.body ?? "Want to take notes?"}
        startLabel={data?.joinUrl ? "Join & Start Recording" : "Start Recording"}
        onStart={() => respond("start")}
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
