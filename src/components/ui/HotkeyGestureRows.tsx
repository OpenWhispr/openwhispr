import type { ReactNode } from "react";
import { Hand, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useHotkeyModeInfo } from "../../hooks/useHotkeyModeInfo";
import { parseHotkeyList } from "../../utils/hotkeys";
import { HotkeyKeycaps } from "./HotkeyKeycaps";

type HotkeySlot = "dictation" | "voiceAgent" | "translation";

interface HotkeyGestureRowsProps {
  slot: HotkeySlot;
  hotkey: string;
  /** The slot's effective mode from the store: Hold, or Tap when it cannot Hold. */
  mode: "tap" | "push";
}

function GestureRow({
  title,
  detail,
  tokens,
}: {
  title: string;
  detail?: string;
  tokens: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{title}</p>
        {detail && <p className="text-[11px] leading-snug text-muted-foreground/70">{detail}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{tokens}</div>
    </div>
  );
}

function VerbChip({ icon, label, accent = false }: { icon: ReactNode; label: string; accent?: boolean }) {
  return (
    <span
      className={
        accent
          ? "hands-free-tip-badge inline-flex h-[22px] items-center gap-1 rounded-full px-2 text-[12px] font-medium"
          : "inline-flex h-[22px] items-center gap-1 rounded-full bg-foreground/[0.07] px-2 text-[12px] font-medium text-muted-foreground"
      }
    >
      {icon}
      {label}
    </span>
  );
}

/**
 * Read-only description of how a hotkey slot is driven. Hold is the only
 * activation model; a slot shows the press-to-toggle row only when its hotkey
 * or backend cannot deliver a release, and then says why.
 */
export function HotkeyGestureRows({ slot, hotkey, mode }: HotkeyGestureRowsProps) {
  const { t } = useTranslation();
  const { pushToTalkUnavailableReason } = useHotkeyModeInfo("settings", hotkey, slot);
  const [primary] = parseHotkeyList(hotkey);
  if (!primary) return null;

  const keycaps = <HotkeyKeycaps hotkey={primary} />;
  const plus = <span className="text-[12px] text-muted-foreground/70">+</span>;

  if (mode === "tap") {
    return (
      <div className="flex flex-col">
        <GestureRow title={t("settingsPage.general.hotkey.gestures.tapOnlyTitle")} tokens={keycaps} />
        {/* A Hold that is missing with no explanation reads as broken, so say
            why — but only when main actually gave a reason. A null reason
            means main believes Hold IS supported (an onboarding Tap choice, a
            Linux evdev slot that lost its input permission), and the generic
            "no native listener" line would then be a specific, false cause.
            No explanation beats a wrong one. */}
        {pushToTalkUnavailableReason && (
          <p className="text-[11px] leading-snug text-muted-foreground/70">
            {pushToTalkUnavailableReason}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-border/30">
      <GestureRow
        title={t("settingsPage.general.hotkey.gestures.holdTitle")}
        detail={t("settingsPage.general.hotkey.gestures.holdDetail")}
        tokens={
          <>
            <VerbChip icon={<Hand className="size-3" aria-hidden="true" />} label={t("common.hold")} />
            {plus}
            {keycaps}
          </>
        }
      />
      <GestureRow
        title={t("settingsPage.general.hotkey.gestures.handsFreeTitle")}
        detail={t("settingsPage.general.hotkey.gestures.handsFreeDetail")}
        tokens={
          <>
            <VerbChip
              icon={<Zap className="size-3" aria-hidden="true" />}
              label={t("settingsPage.general.hotkey.gestures.doublePress")}
              accent
            />
            {plus}
            {keycaps}
          </>
        }
      />
    </div>
  );
}
