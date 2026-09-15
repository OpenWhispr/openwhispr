import type { Platform } from "../../utils/platform";
import LinuxPttSetupInfo from "../ui/LinuxPttSetupInfo";
import { HotkeyGestureRowsContent } from "../ui/HotkeyGestureRows";

interface OnboardingHotkeyGestureCardProps {
  confirmed: boolean;
  slot: "dictation" | "voiceAgent";
  hotkey: string;
  mode: "tap" | "push";
  platform: Platform;
  supportsPushToTalk: boolean;
  pushToTalkUnavailableReason?: string | null;
}

/**
 * Reveals the two gestures only after a user has accepted the slot's shortcut.
 * Linux keeps the existing setup notice when the native listener is unavailable.
 */
export default function OnboardingHotkeyGestureCard({
  confirmed,
  slot,
  hotkey,
  mode,
  platform,
  supportsPushToTalk,
  pushToTalkUnavailableReason,
}: OnboardingHotkeyGestureCardProps) {
  if (!confirmed || !hotkey) return null;

  return (
    <div
      className="onboarding-hotkey-gesture-card onboarding-gesture-reveal mx-auto mt-4 w-full max-w-sm rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-2 text-start"
      data-hotkey-slot={slot}
    >
      <HotkeyGestureRowsContent
        hotkey={hotkey}
        mode={supportsPushToTalk ? mode : "tap"}
        pushToTalkUnavailableReason={pushToTalkUnavailableReason}
      />
      {platform === "linux" && <LinuxPttSetupInfo isAvailable={supportsPushToTalk} />}
    </div>
  );
}
