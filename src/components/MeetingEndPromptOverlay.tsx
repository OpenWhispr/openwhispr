import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { MeetingNotificationCard } from "./MeetingNotificationCard";

interface MeetingEndPromptData {
  countdownMs: number;
}

/**
 * Always-on-top overlay shown when a meeting recording has gone silent. It runs
 * a visible countdown; if it reaches zero the recording is auto-ended, and the
 * single "Keep recording" button cancels the auto-end. Modeled on the update
 * notification overlay (never click-through) so the button is reliable on macOS.
 */
export default function MeetingEndPromptOverlay() {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const respondedRef = useRef(false);

  const respond = useCallback(async (action: string) => {
    if (respondedRef.current) return;
    respondedRef.current = true;
    setIsVisible(false);
    await new Promise((r) => setTimeout(r, 200));
    window.electronAPI?.meetingEndPromptRespond?.(action);
  }, []);

  useEffect(() => {
    let shown = false;

    const show = (d: MeetingEndPromptData) => {
      if (shown) return;
      shown = true;
      const seconds = Math.max(1, Math.ceil((d?.countdownMs ?? 5000) / 1000));
      setSecondsLeft(seconds);
      setTimeout(() => {
        setIsVisible(true);
        window.electronAPI?.meetingEndPromptReady?.();
      }, 50);
    };

    const cleanup = window.electronAPI?.onMeetingEndPromptData?.((incoming: MeetingEndPromptData) =>
      show(incoming)
    );

    window.electronAPI?.getMeetingEndPromptData?.().then((pulled: MeetingEndPromptData | null) => {
      if (pulled) show(pulled);
    });

    return () => cleanup?.();
  }, []);

  // Tick the visible countdown; auto-end when it reaches zero.
  useEffect(() => {
    if (secondsLeft === null) return;
    if (secondsLeft <= 0) {
      respond("end");
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft, respond]);

  return (
    <div className="meeting-notification-window w-full h-full bg-transparent p-3">
      <MeetingNotificationCard
        title={t("meetingEndPrompt.title")}
        body={t("meetingEndPrompt.body", { seconds: secondsLeft ?? 0 })}
        startLabel={t("meetingEndPrompt.keep")}
        onStart={() => respond("keep")}
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
