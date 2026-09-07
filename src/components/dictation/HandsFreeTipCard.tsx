import { Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HotkeyKeycaps } from "../ui/HotkeyKeycaps";
import { TipCardShell, TIP_CARD_WIDTH } from "./TipCardShell";

export const HANDS_FREE_TIP_CARD_WIDTH = TIP_CARD_WIDTH;
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
  const [before, after = ""] = t("app.handsFreeTip.description", { hotkey: HOTKEY_SLOT }).split(
    HOTKEY_SLOT
  );

  return (
    <TipCardShell
      badge={t("app.handsFreeTip.badge")}
      badgeIcon={<Zap className="size-3.5" aria-hidden="true" />}
      title={t("app.handsFreeTip.title")}
      align={align}
      inPlaceOfPill={inPlaceOfPill}
      exiting={exiting}
      countdown={{ durationMs: progressDuration, paused: progressPaused }}
      onDismiss={onDismiss}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <p className="mt-1 text-[15px] leading-snug text-muted-foreground">
        {before}
        <HotkeyKeycaps hotkey={hotkey} />
        {after}
      </p>
    </TipCardShell>
  );
}
