import { useState, useEffect, useCallback } from "react";
import { MeetingNotificationCard } from "./MeetingNotificationCard";

interface NotificationData {
  detectionId: string;
  source: string;
  key: string;
  title: string;
  body: string;
  event: any;
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

  const handleMouseEnter = useCallback(() => {
    setIsHovered(true);
    window.electronAPI?.setNotificationInteractivity?.(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovered(false);
    window.electronAPI?.setNotificationInteractivity?.(false);
  }, []);

  return (
    <div className="meeting-notification-window w-full h-full bg-transparent p-3">
      <MeetingNotificationCard
        title={data?.title ?? "Meeting Detected"}
        body={data?.body ?? "Want to take notes?"}
        startLabel="Start Recording"
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
