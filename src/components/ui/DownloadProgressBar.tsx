import { Loader2 } from "lucide-react";
import { formatETA, type DownloadProgress } from "../../hooks/useModelDownload";

interface DownloadProgressBarProps {
  modelName: string;
  progress: DownloadProgress;
  isInstalling?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)}KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)}GB`;
}

export function DownloadProgressBar({
  modelName,
  progress,
  isInstalling,
}: DownloadProgressBarProps) {
  const { percentage, downloadedBytes, totalBytes, speed, eta } = progress;
  const pct = Math.round(percentage);
  const speedText = speed ? `${speed.toFixed(1)} MB/s` : "";
  const etaText = eta ? formatETA(eta) : "";
  const indeterminate = !isInstalling && totalBytes === 0 && downloadedBytes > 0;

  return (
    <div className="px-2.5 py-2 border-b border-white/5 dark:border-border-subtle">
      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex items-center justify-center h-6 min-w-6 px-1.5 shrink-0">
          <div
            className={`absolute inset-0 rounded-md bg-primary/15 ${isInstalling || indeterminate ? "animate-pulse" : ""}`}
          />
          {isInstalling ? (
            <Loader2 className="relative w-3.5 h-3.5 text-primary animate-spin" />
          ) : (
            <span className="relative text-xs font-bold text-primary tabular-nums">
              {indeterminate ? "···" : `${pct}%`}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-foreground truncate">
            {isInstalling ? `Installing ${modelName}` : `Downloading ${modelName}`}
          </p>
          {!isInstalling && (indeterminate || speedText || etaText) && (
            <div className="flex items-center gap-1.5 mt-0.5">
              {indeterminate && (
                <span className="text-xs text-muted-foreground/70 tabular-nums">
                  {formatBytes(downloadedBytes)}
                </span>
              )}
              {speedText && (
                <span className="text-xs text-muted-foreground/70 tabular-nums">{speedText}</span>
              )}
              {etaText && (
                <>
                  <span className="text-xs text-muted-foreground/30">·</span>
                  <span className="text-xs text-muted-foreground/70 tabular-nums">{etaText}</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        className="w-full rounded-full overflow-hidden bg-white/5 dark:bg-white/3"
        style={{ height: 4 }}
      >
        {indeterminate ? (
          <div className="h-full w-1/3 rounded-full bg-primary shadow-[0_0_8px_oklch(0.62_0.22_260/0.4)] animate-[indeterminate_1.5s_ease-in-out_infinite]" />
        ) : (
          <div
            className={`${isInstalling ? "animate-pulse" : ""} bg-primary shadow-[0_0_8px_oklch(0.62_0.22_260/0.4)]`}
            style={{
              height: "100%",
              width: `${isInstalling ? 100 : Math.min(percentage, 100)}%`,
              borderRadius: 9999,
              transition: "width 300ms ease-out",
            }}
          />
        )}
      </div>
    </div>
  );
}
