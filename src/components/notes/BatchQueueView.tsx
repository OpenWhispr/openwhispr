import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, X, Loader2, Clock, Trash2 } from "../icons";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { CARD_SURFACE_CLASS } from "../ui/surfaces";
import type { QueueItem } from "../../stores/batchQueueStore";

interface BatchQueueViewProps {
  queue: QueueItem[];
  byokMaxFileSizeMb: number;
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
      return <Check size={14} className="shrink-0 text-success" />;
    case "error":
      return <X size={14} className="shrink-0 text-destructive" />;
    case "queued":
      return <Clock size={14} className="shrink-0 text-muted-foreground" />;
    default:
      return <Loader2 size={14} className="shrink-0 animate-spin text-primary" />;
  }
}

interface BatchWarningIndicatorProps {
  transcriptionWarning: boolean;
  diarizationWarning: boolean;
  t: (key: string) => string;
}

export function BatchWarningIndicator({
  transcriptionWarning,
  diarizationWarning,
  t,
}: BatchWarningIndicatorProps): JSX.Element | null {
  const messages: string[] = [];
  if (transcriptionWarning) messages.push(t("notes.upload.partialWarning"));
  if (diarizationWarning) messages.push(t("notes.upload.diarizationWarning"));
  if (messages.length === 0) return null;

  const label = messages.join(" ");
  return (
    <span className="flex shrink-0" role="img" title={label} aria-label={label}>
      <AlertTriangle size={11} className="text-warning" />
    </span>
  );
}

export default function BatchQueueView({
  queue,
  byokMaxFileSizeMb,
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
    <div
      className={cn(CARD_SURFACE_CLASS, "overflow-clip")}
      style={{ animation: "float-up 0.3s ease-out" }}
    >
      <div className="px-4 pt-4 pb-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-foreground">
            {t("notes.upload.queueProgress", {
              completed: completedCount,
              total: totalCount,
            })}
            {failedCount > 0 && (
              <span className="font-normal text-destructive">
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
              className="h-7 rounded-full px-3 text-xs"
            >
              {t("notes.upload.clearQueue")}
            </Button>
          )}
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-foreground/8 dark:bg-white/10">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
            style={{ width: `${overallProgress}%` }}
          />
        </div>
      </div>

      <div className="max-h-[300px] divide-y divide-border/60 overflow-y-auto border-t border-border/60 dark:divide-white/10 dark:border-white/10">
        {queue.map((item) => (
          <div
            key={item.id}
            className={cn(
              "flex min-h-12 items-center gap-3 px-4 py-2 text-sm",
              item.status === "error" && "bg-destructive/5"
            )}
          >
            <StatusIcon status={item.status} />
            <span className="flex-1 truncate text-foreground/80">{item.name}</span>

            {item.status === "downloading" && (
              <div className="h-1 w-16 overflow-hidden rounded-full bg-foreground/8 dark:bg-white/10">
                <div
                  className={cn(
                    "h-full rounded-full bg-primary transition-[width] duration-300",
                    // Percent 0 = size unknown: pulse instead of an empty bar.
                    !item.progress && "animate-pulse"
                  )}
                  style={{ width: item.progress ? `${item.progress}%` : "100%" }}
                />
              </div>
            )}

            {item.status === "done" && (
              <BatchWarningIndicator
                transcriptionWarning={!!item.warning}
                diarizationWarning={!!item.diarizationWarning}
                t={t}
              />
            )}

            {item.status === "done" && item.noteId && onOpenNote && (
              <button
                onClick={() => onOpenNote(item.noteId!)}
                className="text-xs font-medium text-primary hover:underline"
                aria-label={t("notes.upload.openNote")}
              >
                {t("notes.upload.openNote")}
              </button>
            )}

            {item.status === "error" && item.error && (
              <span
                className="max-w-40 truncate text-xs text-destructive"
                title={t(`notes.upload.${item.error}`, {
                  defaultValue: item.error,
                  size: byokMaxFileSizeMb,
                })}
              >
                {t(`notes.upload.${item.error}`, {
                  defaultValue: item.error,
                  size: byokMaxFileSizeMb,
                })}
              </span>
            )}

            {item.status === "queued" && (
              <button
                onClick={() => onRemoveItem(item.id)}
                className="flex size-7 shrink-0 items-center justify-center rounded-full text-foreground/45 transition-colors hover:bg-foreground/5 hover:text-foreground"
                aria-label={t("notes.upload.removeFromQueue")}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))}
      </div>

      {isProcessing && !allDone && (
        <div className="flex justify-center border-t border-border/60 py-2 dark:border-white/10">
          <Button variant="ghost" size="sm" onClick={onCancelAll} className="rounded-full px-4">
            {t("notes.upload.cancelAll")}
          </Button>
        </div>
      )}
    </div>
  );
}
