import { useTranslation } from "react-i18next";
import { Download, X, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import {
  useModelAutoDownloadStore,
  cancelAutoDownload,
  dismissAutoDownloadBanner,
} from "../stores/modelAutoDownloadStore";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function ModelDownloadBanner() {
  const { t } = useTranslation();
  const { isActive, isComplete, isCancelled, error, isDismissed, progress, sizeMb } =
    useModelAutoDownloadStore();

  // Don't show if dismissed, complete, cancelled, or not active
  if (isDismissed || isComplete || isCancelled) return null;
  if (!isActive && !error) return null;

  const percentage = Math.round(progress.percentage);
  const downloaded = formatBytes(progress.downloadedBytes);
  const total = progress.totalBytes > 0 ? formatBytes(progress.totalBytes) : `~${sizeMb || 680} MB`;

  return (
    <div className="max-w-3xl mx-auto w-full mb-3">
      <div className="rounded-lg border border-primary/20 dark:border-primary/15 bg-primary/5 p-3">
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center">
            {isActive ? (
              <Loader2 size={16} className="text-primary animate-spin" />
            ) : (
              <Download size={16} className="text-primary" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            {error ? (
              <>
                <p className="text-xs font-medium text-foreground mb-0.5">
                  {t("controlPanel.modelDownload.errorTitle")}
                </p>
                <p className="text-xs text-muted-foreground mb-2">{error}</p>
                <button
                  onClick={() => dismissAutoDownloadBanner()}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t("controlPanel.modelDownload.dismiss")}
                </button>
              </>
            ) : (
              <>
                <p className="text-xs font-medium text-foreground mb-0.5">
                  {t("controlPanel.modelDownload.title")}
                </p>
                <p className="text-xs text-muted-foreground mb-2">
                  {t("controlPanel.modelDownload.description")}
                </p>
                {/* Progress bar */}
                <div className="w-full bg-muted rounded-full h-1.5 mb-1.5">
                  <div
                    className="bg-primary h-1.5 rounded-full transition-all duration-300"
                    style={{ width: `${Math.max(percentage, 1)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">
                    {percentage > 0
                      ? t("controlPanel.modelDownload.progress", { downloaded, total, percentage })
                      : t("controlPanel.modelDownload.starting")}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
                    onClick={async () => {
                      await cancelAutoDownload();
                    }}
                  >
                    <X size={12} className="mr-1" />
                    {t("controlPanel.modelDownload.cancel")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
