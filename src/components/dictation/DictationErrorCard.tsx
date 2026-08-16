import { useLayoutEffect, useRef } from "react";
import { RotateCcw, ScrollText } from "lucide-react";
import { cn } from "../lib/utils";
import type { ToastActionConfig } from "../ui/useToast";

interface DictationErrorCardProps {
  title?: string;
  description?: string;
  actions: ToastActionConfig[];
  onAction: (action: ToastActionConfig) => void;
  onPreferredHeightChange?: (height: number) => void;
  progressDuration?: number;
  progressPaused?: boolean;
}

const ACTION_ICONS = {
  retry: RotateCcw,
  transcript: ScrollText,
};

/** Shared one/two-action error surface for the floating dictation window. */
export function DictationErrorCard({
  title,
  description,
  actions,
  onAction,
  onPreferredHeightChange,
  progressDuration = 0,
  progressPaused = false,
}: DictationErrorCardProps) {
  const cardRef = useRef<HTMLElement | null>(null);
  const lastPreferredHeightRef = useRef(0);
  const hasSecondaryAction = actions.length > 1;

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !onPreferredHeightChange) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const preferredHeight = Math.ceil(Math.max(card.offsetHeight, card.scrollHeight));
      if (Math.abs(preferredHeight - lastPreferredHeightRef.current) < 1) return;
      lastPreferredHeightRef.current = preferredHeight;
      onPreferredHeightChange(preferredHeight);
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(card);
    scheduleMeasure();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [onPreferredHeightChange]);

  const text = (
    <div className="min-w-0 flex-1 break-words">
      {title && (
        <h2 className="text-base font-medium leading-snug text-foreground">{title}</h2>
      )}
      {description && (
        <p className="mt-1 whitespace-pre-wrap text-sm leading-snug text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );

  const renderAction = (action: ToastActionConfig, index: number) => {
    const Icon = action.icon ? ACTION_ICONS[action.icon] : null;
    const primary = index === 0;

    return (
      <button
        key={`${action.label}-${index}`}
        type="button"
        onClick={() => onAction(action)}
        className={cn(
          "inline-flex h-10 min-w-0 items-center justify-center gap-2 rounded-full px-5",
          "text-sm font-medium transition-[background-color,color,transform] duration-150",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.98]",
          primary
            ? "bg-foreground text-background hover:bg-foreground/90"
            : "bg-foreground/15 text-foreground hover:bg-foreground/20"
        )}
      >
        {Icon && <Icon className="size-4 shrink-0" aria-hidden="true" />}
        <span className="truncate">{action.label}</span>
      </button>
    );
  };

  return (
    <section
      ref={cardRef}
      role="alert"
      aria-live="assertive"
      data-action-count={actions.length}
      className={cn(
        "relative max-h-[calc(100vh-1.5rem)] w-full overflow-y-auto rounded-3xl border border-border/50 bg-surface-0",
        "shadow-[var(--shadow-modal)]"
      )}
    >
      {progressDuration > 0 && (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px overflow-hidden rounded-t-3xl"
          aria-hidden="true"
        >
          <div
            className="h-full bg-foreground"
            style={{
              animation: `toast-progress ${progressDuration}ms linear forwards`,
              animationPlayState: progressPaused ? "paused" : "running",
            }}
          />
        </div>
      )}
      {hasSecondaryAction ? (
        <div className="p-4">
          {text}
          <div className="mt-4 grid grid-cols-2 gap-3">{actions.map(renderAction)}</div>
        </div>
      ) : (
        <div className="p-4">
          {text}
          <div className="mt-4 flex justify-end">{actions.slice(0, 1).map(renderAction)}</div>
        </div>
      )}
    </section>
  );
}
