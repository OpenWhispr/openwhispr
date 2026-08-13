import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, X, Loader2, Clock, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import type { QueueItem } from "../../stores/batchQueueStore";

interface BatchQueueViewProps {
  queue: QueueItem[];
  completedCount: number;
  failedCount: number;
  totalCount: number;
  isProcessing: boolean;
  onRemoveItem: (id: string) => void;
  onCancelAll: () => void;
  onClearQueue: () => void;
  onOpenNote?: (noteId: number) => void;
}

function StatusIcon({ status }: { status: QueueItem["status"] }) {
  switch (status) {
    case "done":
      return <Check size={12} className="text-success/70" />;
    case "error":
      return <X size={12} className="text-destructive/70" />;
    case "queued":
      return <Clock size={12} className="text-foreground/20" />;
    default:
      return <Loader2 size={12} className="text-primary/60 animate-spin" />;
  }
}

export default function BatchQueueView({
  queue,
  completedCount,
  failedCount,
  totalCount,
  isProcessing,
  onRemoveItem,
  onCancelAll,
  onClearQueue,
  onOpenNote,
}: BatchQueueViewProps) {
  const { t } = useTranslation();
  const allDone =
    queue.length > 0 && queue.every((i) => i.status === "done" || i.status === "error");
  // Failed items still count as settled so the bar reaches 100% when the run ends.
  const overallProgress =
    totalCount > 0 ? Math.round(((completedCount + failedCount) / totalCount) * 100) : 0;

  return (
    <div style={{ animation: "float-up 0.3s ease-out" }}>
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs text-foreground/50 font-medium">
            {t("notes.upload.queueProgress", {
              completed: completedCount,
              total: totalCount,
            })}
            {failedCount > 0 && (
              <span className="text-destructive/50 font-normal">
                {" · "}
                {t("notes.upload.queueFailed", { n: failedCount })}
              </span>
            )}
          </p>
          {allDone && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearQueue}
              className="h-6 text-[10px] text-foreground/30"
            >
              {t("notes.upload.clearQueue")}
            </Button>
          )}
        </div>
        <div className="w-full h-[3px] rounded-full bg-foreground/5 dark:bg-white/5 overflow-hidden">
          <div
            className="h-full rounded-full bg-primary/50 transition-[width] duration-500 ease-out"
            style={{ width: `${overallProgress}%` }}
          />
        </div>
      </div>

      <div className="space-y-1 max-h-[300px] overflow-y-auto">
        {queue.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs",
              "bg-surface-1/30 dark:bg-white/[0.02] border border-foreground/4 dark:border-white/4",
              item.status === "error" && "border-destructive/15"
            )}
          >
            <StatusIcon status={item.status} />
            <span className="flex-1 truncate text-foreground/60">{item.name}</span>

            {item.status === "downloading" && (
              <div className="w-16 h-[2px] rounded-full bg-foreground/5 overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full bg-primary/50 transition-[width] duration-300",
                    // Percent 0 = size unknown: pulse instead of an empty bar.
                    !item.progress && "animate-pulse"
                  )}
                  style={{ width: item.progress ? `${item.progress}%` : "100%" }}
                />
              </div>
            )}

            {item.status === "done" && item.warning && (
              <span className="flex shrink-0" title={t("notes.upload.partialWarning")}>
                <AlertTriangle size={11} className="text-amber-500/60" />
              </span>
            )}

            {item.status === "done" && item.noteId && onOpenNote && (
              <button
                onClick={() => onOpenNote(item.noteId!)}
                className="text-[10px] text-primary/50 hover:text-primary/70"
                aria-label={t("notes.upload.openNote")}
              >
                {t("notes.upload.openNote")}
              </button>
            )}

            {item.status === "error" && item.error && (
              <span
                className="text-[10px] text-destructive/50 truncate max-w-20"
                title={t(`notes.upload.${item.error}`, { defaultValue: item.error })}
              >
                {t(`notes.upload.${item.error}`, { defaultValue: item.error })}
              </span>
            )}

            {item.status === "queued" && (
              <button
                onClick={() => onRemoveItem(item.id)}
                className="text-foreground/15 hover:text-foreground/40 transition-colors"
                aria-label={t("notes.upload.removeFromQueue")}
              >
                <Trash2 size={10} />
              </button>
            )}
          </div>
        ))}
      </div>

      {isProcessing && !allDone && (
        <div className="flex justify-center mt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancelAll}
            className="h-7 text-xs text-foreground/30"
          >
            {t("notes.upload.cancelAll")}
          </Button>
        </div>
      )}
    </div>
  );
}
