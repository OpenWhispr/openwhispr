import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { Button } from "./button";
import { useMeetingDetectionHealth } from "../../hooks/useMeetingDetectionHealth";

const DISMISSED_KEY = "meetingDetectionNoticeDismissed";

interface MeetingDetectionNoticeProps {
  onOpenSettings: () => void;
}

/**
 * Detection failing is silent by design — there is no prompt to miss when the
 * thing that produces prompts is the thing that broke. This says so once.
 */
export default function MeetingDetectionNotice({ onOpenSettings }: MeetingDetectionNoticeProps) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(DISMISSED_KEY) === "true"
  );
  const { health } = useMeetingDetectionHealth(!dismissed);

  if (dismissed || health?.status !== "unavailable") return null;

  return (
    <div className="max-w-3xl mx-auto w-full mb-3">
      <div className="rounded-lg border border-warning/20 bg-warning/8 dark:bg-warning/10 p-3">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-8 h-8 rounded-md bg-warning/15 flex items-center justify-center">
            <AlertCircle size={16} className="text-amber-600 dark:text-warning" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground mb-0.5">
              {t("settings.meetingDetection.notice.title")}
            </p>
            <p className="text-xs text-muted-foreground mb-2">
              {t("settings.meetingDetection.notice.description")}
              {health?.reason ? ` ${t("settings.meetingDetection.reason", { reason: health.reason })}` : ""}
            </p>
            <div className="flex items-center gap-3">
              <Button variant="default" size="sm" className="h-7 text-xs" onClick={onOpenSettings}>
                {t("settings.meetingDetection.notice.action")}
              </Button>
              <button
                onClick={() => {
                  setDismissed(true);
                  localStorage.setItem(DISMISSED_KEY, "true");
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("settings.meetingDetection.notice.dismiss")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
