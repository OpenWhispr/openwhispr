import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { CardCountdownArc } from "./CardCountdownArc";

export const TIP_CARD_WIDTH = 320;
const CARD_RADIUS = 24;

const ALIGN_CLASS = {
  right: "right-0",
  left: "left-0",
  center: "left-1/2 -translate-x-1/2",
};

interface TipCardShellProps {
  badge: ReactNode;
  badgeIcon: ReactNode;
  title: ReactNode;
  children: ReactNode;
  align: "left" | "center" | "right";
  /** With the pill auto-hidden the card stands where the pill would be. */
  inPlaceOfPill: boolean;
  exiting?: boolean;
  countdown?: { durationMs: number; paused: boolean } | null;
  onDismiss: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  className?: string;
}

/** The chrome shared by the hands-free tip and the Hold migration card. */
export function TipCardShell({
  badge,
  badgeIcon,
  title,
  children,
  align,
  inPlaceOfPill,
  exiting = false,
  countdown = null,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
  className,
}: TipCardShellProps) {
  const { t } = useTranslation();
  return (
    <section
      role="status"
      aria-live="polite"
      data-exiting={exiting || undefined}
      className={cn(
        "hands-free-tip-card absolute z-10 w-80 overflow-hidden rounded-3xl border border-border/50 bg-surface-0 p-5",
        "shadow-[var(--shadow-modal)]",
        inPlaceOfPill ? "bottom-0" : "bottom-full mb-2",
        ALIGN_CLASS[align],
        className
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {countdown && (
        <CardCountdownArc
          width={TIP_CARD_WIDTH}
          radius={CARD_RADIUS}
          durationMs={countdown.durationMs}
          paused={countdown.paused}
        />
      )}
      <span className="hands-free-tip-badge inline-flex h-6 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-[13px] font-medium">
        {badgeIcon}
        {badge}
      </span>
      <button
        type="button"
        aria-label={t("common.dismiss")}
        onClick={onDismiss}
        className="absolute right-4.5 top-4.5 flex size-7 items-center justify-center rounded-full border border-border/55 bg-surface-2 text-muted-foreground shadow-sm transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <X size={13} strokeWidth={2.5} aria-hidden="true" />
      </button>
      <p className="mt-3.5 text-base font-medium leading-snug text-foreground">{title}</p>
      {children}
    </section>
  );
}
