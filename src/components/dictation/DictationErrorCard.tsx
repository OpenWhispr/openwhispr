import { RotateCcw, ScrollText } from "lucide-react";
import { cn } from "../lib/utils";
import type { ToastActionConfig } from "../ui/useToast";

interface DictationErrorCardProps {
  title?: string;
  description?: string;
  actions: ToastActionConfig[];
  onAction: (action: ToastActionConfig) => void;
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
}: DictationErrorCardProps) {
  const hasSecondaryAction = actions.length > 1;

  const text = (
    <div className="min-w-0 flex-1">
      {title && (
        <h2 className="line-clamp-2 text-base font-medium leading-snug text-foreground">{title}</h2>
      )}
      {description && (
        <p className="mt-1 line-clamp-2 text-sm leading-snug text-muted-foreground">
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
      role="alert"
      aria-live="assertive"
      data-action-count={actions.length}
      className={cn(
        "w-full overflow-hidden rounded-3xl border border-border/50 bg-surface-0",
        "shadow-[var(--shadow-modal)]"
      )}
    >
      {hasSecondaryAction ? (
        <div className="p-4">
          {text}
          <div className="mt-4 grid grid-cols-2 gap-3">{actions.map(renderAction)}</div>
        </div>
      ) : (
        <div className="flex items-center gap-4 p-4">
          {text}
          <div className="shrink-0">{actions.slice(0, 1).map(renderAction)}</div>
        </div>
      )}
    </section>
  );
}
