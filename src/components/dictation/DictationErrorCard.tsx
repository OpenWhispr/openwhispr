import { useLayoutEffect, useRef } from "react";
import { RotateCcw, ScrollText } from "lucide-react";
import { ASSISTANT_PANEL_SIZE_LIMITS } from "../../helpers/voiceSurfaceGeometry.mjs";
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
  ready?: boolean;
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
  ready = true,
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
      // The card first mounts inside the compact pill window. Wait until the
      // native window has established its final error width so wrapping is
      // measured once at the width the user will actually see.
      const availableSurfaceWidth = Math.max(
        1,
        window.screen.availWidth - ASSISTANT_PANEL_SIZE_LIMITS.gutter
      );
      const availableSurfaceHeight = Math.max(
        1,
        window.screen.availHeight - ASSISTANT_PANEL_SIZE_LIMITS.gutter
      );
      const expectedWidth = Math.min(
        ASSISTANT_PANEL_SIZE_LIMITS.ratioWidth,
        availableSurfaceWidth,
        Math.floor(
          availableSurfaceHeight *
            (ASSISTANT_PANEL_SIZE_LIMITS.ratioWidth / ASSISTANT_PANEL_SIZE_LIMITS.ratioHeight)
        )
      );
      if (Math.abs(card.getBoundingClientRect().width - expectedWidth) > 1) return;
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
    <div className="min-w-0 flex-1 break-words px-2 py-1">
      {title && <p className="text-base font-normal leading-snug text-foreground">{title}</p>}
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
          "inline-flex h-8 min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-full px-4",
          "text-sm font-medium transition-[background-color,color,transform] duration-150",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 active:scale-[0.98]",
          primary
            ? "bg-foreground text-background hover:bg-foreground/90"
            : "bg-foreground/15 text-foreground hover:bg-foreground/20"
        )}
      >
        {Icon && <Icon className="size-3.5 shrink-0" aria-hidden="true" />}
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
        "relative max-h-[calc(100vh-1.5rem)] w-full overflow-y-auto rounded-2xl border border-border/50 bg-surface-0",
        "shadow-[var(--shadow-modal)] transition-[opacity,transform] duration-200 ease-out",
        ready ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"
      )}
    >
      {progressDuration > 0 && (
        <svg
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-4 w-full overflow-visible text-foreground"
          viewBox="0 0 442 17"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            d="M 1 16 A 15 15 0 0 1 16 1 H 426 A 15 15 0 0 1 441 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="butt"
            pathLength="1"
            strokeDasharray="1"
            style={{
              animation: `toast-border-progress ${progressDuration}ms linear forwards`,
              animationPlayState: progressPaused ? "paused" : "running",
            }}
          />
        </svg>
      )}
      {hasSecondaryAction ? (
        <div className="px-2 py-3">
          {text}
          <div className="mt-3 grid grid-cols-2 gap-2">{actions.map(renderAction)}</div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-2 py-3">
          {text}
          {actions.slice(0, 1).map(renderAction)}
        </div>
      )}
    </section>
  );
}
