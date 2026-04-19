import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";

interface UpdateNotificationData {
  version: string;
  releaseDate?: string;
}

export default function UpdateNotificationOverlay() {
  const { t } = useTranslation();
  const [data, setData] = useState<UpdateNotificationData | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isHovered, setIsHovered] = useState(false);

  useEffect(() => {
    let shown = false;

    const show = (d: UpdateNotificationData) => {
      if (shown) return;
      shown = true;
      setData(d);
      setTimeout(() => {
        setIsVisible(true);
        window.electronAPI?.updateNotificationReady?.();
      }, 50);
    };

    const cleanup = window.electronAPI?.onUpdateNotificationData?.(
      (incoming: UpdateNotificationData) => show(incoming)
    );

    window.electronAPI
      ?.getUpdateNotificationData?.()
      .then((pulled: UpdateNotificationData | null) => {
        if (pulled) show(pulled);
      });

    return () => cleanup?.();
  }, []);

  const respond = useCallback(
    async (action: string) => {
      if (!data) return;
      setIsVisible(false);
      await new Promise((r) => setTimeout(r, 200));
      window.electronAPI?.updateNotificationRespond?.(action);
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
      <div
        className={[
          "relative",
          "bg-card/95 dark:bg-surface-2/95 backdrop-blur-xl",
          "border border-border/40 dark:border-border-subtle/40",
          "rounded-xl shadow-lg p-2.5",
          "transition-all duration-300 ease-out",
          isVisible
            ? "translate-x-0 opacity-100 scale-100"
            : "translate-x-[120%] opacity-0 scale-95",
        ].join(" ")}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <button
          onClick={() => respond("dismiss")}
          className={[
            "absolute -left-2.5 -top-2.5 z-10 size-6 rounded-full",
            "flex items-center justify-center",
            "bg-card dark:bg-surface-2 border border-border/40 dark:border-border-subtle/40 shadow-sm",
            "text-muted-foreground/70 hover:text-foreground hover:bg-muted",
            "transition-all duration-150",
            isHovered ? "opacity-100 scale-100" : "opacity-0 scale-75 pointer-events-none",
          ].join(" ")}
        >
          <X className="size-3" />
        </button>

        <div className="flex items-center gap-2.5">
          <div className="shrink-0 bg-primary/10 rounded-md p-1">
            <svg viewBox="0 0 1024 1024" className="w-4.5 h-4.5">
              <rect width="1024" height="1024" rx="241" fill="#2056DF" />
              <circle cx="512" cy="512" r="314" fill="#2056DF" stroke="white" strokeWidth="74" />
              <path d="M512 383V641" stroke="white" strokeWidth="74" strokeLinecap="round" />
              <path d="M627 457V568" stroke="white" strokeWidth="74" strokeLinecap="round" />
              <path d="M397 457V568" stroke="white" strokeWidth="74" strokeLinecap="round" />
            </svg>
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-semibold text-foreground leading-tight truncate">
              {t("updateNotification.title")}
            </p>
            <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">
              {t("updateNotification.body", { version: data?.version ?? "" })}
            </p>
          </div>

          <button
            onClick={() => respond("update")}
            className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/80 text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors"
          >
            {t("updateNotification.cta")}
          </button>
        </div>
      </div>
    </div>
  );
}
