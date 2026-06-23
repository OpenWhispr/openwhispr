import { X } from "lucide-react";

interface MeetingNotificationCardProps {
  title: string;
  body: string;
  startLabel: string;
  onStart?: () => void;
  onDismiss?: () => void;
  /** Controls the close button's hover fade. Ignored when `onDismiss` is absent. */
  closeVisible?: boolean;
  className?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

/**
 * Presentational only — shared by the live always-on-top overlay
 * (`MeetingNotificationOverlay`) and the onboarding preview so the two never
 * drift. Behaviour (slide animation, IPC, hover) is layered on by the caller
 * via `className` and the handler props.
 */
export function MeetingNotificationCard({
  title,
  body,
  startLabel,
  onStart,
  onDismiss,
  closeVisible = true,
  className = "",
  onMouseEnter,
  onMouseLeave,
}: MeetingNotificationCardProps) {
  return (
    <div
      className={[
        "relative",
        "bg-card/95 dark:bg-surface-2/95 backdrop-blur-xl",
        "border border-border/40 dark:border-border-subtle/40",
        "rounded-xl shadow-lg p-2.5",
        className,
      ].join(" ")}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {onDismiss && (
        <button
          onClick={onDismiss}
          className={[
            "absolute -left-2.5 -top-2.5 z-10 size-6 rounded-full",
            "flex items-center justify-center",
            "bg-card dark:bg-surface-2 border border-border/40 dark:border-border-subtle/40 shadow-sm",
            "text-muted-foreground/70 hover:text-foreground hover:bg-muted",
            "transition-all duration-150",
            closeVisible ? "opacity-100 scale-100" : "opacity-0 scale-75 pointer-events-none",
          ].join(" ")}
        >
          <X className="size-3" />
        </button>
      )}

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
            {title}
          </p>
          <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{body}</p>
        </div>

        <button
          onClick={onStart}
          className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors"
        >
          {startLabel}
        </button>
      </div>
    </div>
  );
}
