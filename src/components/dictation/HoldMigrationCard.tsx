import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HotkeyKeycaps } from "../ui/HotkeyKeycaps";
import { TipCardShell } from "./TipCardShell";

const HOTKEY_SLOT = "\u0000";

interface HoldMigrationCardProps {
  /** The user's real dictation hotkey (first of the list). */
  hotkey: string;
  align: "left" | "center" | "right";
  inPlaceOfPill: boolean;
  exiting?: boolean;
  onDismiss: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

/**
 * One-time card on the first hotkey press after the update moved the user
 * from Tap to Hold. It introduces the change; it never asks for a decision.
 * No button: the X dismisses it, and the next press is the practice.
 */
export function HoldMigrationCard({
  hotkey,
  align,
  inPlaceOfPill,
  exiting = false,
  onDismiss,
  onMouseEnter,
  onMouseLeave,
}: HoldMigrationCardProps) {
  const { t } = useTranslation();
  const [before, after = ""] = t("app.holdMigrationCard.description", {
    hotkey: HOTKEY_SLOT,
  }).split(HOTKEY_SLOT);

  return (
    <TipCardShell
      badge={t("app.holdMigrationCard.badge")}
      badgeIcon={<Sparkles className="size-3.5" aria-hidden="true" />}
      title={t("app.holdMigrationCard.title")}
      align={align}
      inPlaceOfPill={inPlaceOfPill}
      exiting={exiting}
      onDismiss={onDismiss}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <p className="mt-1 text-[15px] leading-snug text-muted-foreground">
        {before}
        <HotkeyKeycaps hotkey={hotkey} />
        {after}
      </p>
      <p className="mt-1 text-[15px] leading-snug text-muted-foreground">
        {t("app.holdMigrationCard.gesture")}
      </p>
    </TipCardShell>
  );
}
