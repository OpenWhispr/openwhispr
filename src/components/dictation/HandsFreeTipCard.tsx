import { X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { CardCountdownArc } from "./CardCountdownArc";

export const HANDS_FREE_TIP_CARD_WIDTH = 320;
const CARD_RADIUS = 24;
// The translated sentence carries the hotkey as `{{hotkey}}`; rendering it as
// keycaps means splitting the resolved copy around that slot.
const HOTKEY_SLOT = "\u0000";

interface HandsFreeTipCardProps {
  hotkey: string;
  align: "left" | "center" | "right";
  /** With the pill auto-hidden the tip stands where the pill would be. */
  inPlaceOfPill: boolean;
  exiting?: boolean;
  progressDuration: number;
  progressPaused: boolean;
  onDismiss: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const ALIGN_CLASS = {
  right: "right-0",
  left: "left-0",
  center: "left-1/2 -translate-x-1/2",
};

/** Post-hold nudge toward the double-press hands-free gesture. */
export function HandsFreeTipCard({
  hotkey,
  align,
  inPlaceOfPill,
  exiting = false,
  progressDuration,
  progressPaused,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
}: HandsFreeTipCardProps) {
  const { t } = useTranslation();
  const keycaps = formatHotkeyLabel(hotkey).split("+");
  const [before, after = ""] = t("app.handsFreeTip.description", { hotkey: HOTKEY_SLOT }).split(
    HOTKEY_SLOT
  );

  return (
    <section
      role="status"
      aria-live="polite"
      data-exiting={exiting || undefined}
      className={cn(
        "hands-free-tip-card absolute z-10 w-80 overflow-hidden rounded-3xl border border-border/50 bg-surface-0 p-5",
        "shadow-[var(--shadow-modal)]",
        inPlaceOfPill ? "bottom-0" : "bottom-full mb-2",
        ALIGN_CLASS[align]
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <CardCountdownArc
        width={HANDS_FREE_TIP_CARD_WIDTH}
        radius={CARD_RADIUS}
        durationMs={progressDuration}
        paused={progressPaused}
      />
      <span className="hands-free-tip-badge inline-flex h-6 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-[13px] font-medium">
        <Zap className="size-3.5" aria-hidden="true" />
        {t("app.handsFreeTip.badge")}
      </span>
      <button
        type="button"
        aria-label={t("common.dismiss")}
        onClick={onDismiss}
        className="absolute right-4.5 top-4.5 flex size-7 items-center justify-center rounded-full border border-border/55 bg-surface-2 text-muted-foreground shadow-sm transition-colors hover:bg-surface-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <X size={13} strokeWidth={2.5} aria-hidden="true" />
      </button>
      <p className="mt-3.5 text-base font-medium leading-snug text-foreground">
        {t("app.handsFreeTip.title")}
      </p>
      <p className="mt-1 text-[15px] leading-snug text-muted-foreground">
        {before}
        {keycaps.map((part, index) => (
          <span key={`${part}-${index}`}>
            {index > 0 && " + "}
            <kbd className="rounded-md border border-border/40 bg-foreground/5 px-1.5 py-0.5 font-mono text-[12px] text-foreground/65 shadow-sm">
              {part}
            </kbd>
          </span>
        ))}
        {after}
      </p>
    </section>
  );
}
