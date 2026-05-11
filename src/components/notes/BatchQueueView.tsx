import { useTranslation } from "react-i18next";
import { Check, X, Loader2, Clock, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import type { QueueItem } from "../../hooks/useBatchQueue";

interface BatchQueueViewProps {
  queue: QueueItem[];
  completedCount: number;
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
  totalCount,
  isProcessing,
  onRemoveItem,
  onCancelAll,
  onClearQueue,
  onOpenNote,
}: BatchQueueViewProps) {
  const { t } = useTranslation();
  const allDone = queue.every(
    (i) => i.status === "done" || i.status === "error"
  );
  const overallProgress =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div style={{ animation: "float-up 0.3s ease-out" }}>
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <p className="text-xs text-foreground/50 font-medium">
            {t("notes.upload.queueProgress", {
              completed: completedCount,
              total: totalCount,
            })}
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
            <span className="flex-1 truncate text-foreground/60">
              {item.name}
            </span>

            {(item.status === "downloading" ||
              item.status === "transcribing") && (
              <div className="w-16 h-[2px] rounded-full bg-foreground/5 overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary/50 transition-[width] duration-300"
                  style={{ width: `${item.progress}%` }}
                />
              </div>
            )}

            {item.status === "diarizing" && (
              <span className="text-[10px] text-primary/50">
                {t("notes.upload.diarizing")}
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
                className="text-[10px] text-destructive/50 truncate max-w-[80px]"
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
