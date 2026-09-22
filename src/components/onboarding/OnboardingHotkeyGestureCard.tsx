import type { Platform } from "../../utils/platform";
import LinuxPttSetupInfo from "../ui/LinuxPttSetupInfo";
import { HotkeyGestureRowsContent } from "../ui/HotkeyGestureRows";

interface OnboardingHotkeyGestureCardProps {
  confirmed: boolean;
  slot: "dictation" | "voiceAgent";
  hotkey: string;
  mode: "tap" | "push";
  platform: Platform;
  isUsingNativeShortcut: boolean;
  supportsPushToTalk: boolean;
  linuxPttPermissionDenied?: boolean;
  pushToTalkUnavailableReason?: string | null;
}

/**
 * Teaches the gestures once, after the Dictation shortcut is confirmed.
 * Linux keeps the listener setup notice only for non-native shortcuts.
 */
export default function OnboardingHotkeyGestureCard({
  confirmed,
  slot,
  hotkey,
  mode,
  platform,
  isUsingNativeShortcut,
  supportsPushToTalk,
  linuxPttPermissionDenied = false,
  pushToTalkUnavailableReason,
}: OnboardingHotkeyGestureCardProps) {
  if (!confirmed || !hotkey) return null;

  if (slot === "voiceAgent") {
    return platform === "linux" && !supportsPushToTalk && pushToTalkUnavailableReason ? (
      <p role="status" className="mx-auto mt-3 max-w-sm text-sm text-muted-foreground">
        {pushToTalkUnavailableReason}
      </p>
    ) : null;
  }

  const needsLinuxSetup =
    platform === "linux" && !isUsingNativeShortcut && linuxPttPermissionDenied;

  return (
    <div
      className="onboarding-hotkey-gesture-card onboarding-gesture-reveal mx-auto mt-4 w-full max-w-sm rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-2 text-start"
      data-hotkey-slot={slot}
    >
      <HotkeyGestureRowsContent
        hotkey={hotkey}
        mode={supportsPushToTalk && !needsLinuxSetup ? mode : "tap"}
        pushToTalkUnavailableReason={pushToTalkUnavailableReason}
      />
      {needsLinuxSetup && <LinuxPttSetupInfo isAvailable={false} />}
    </div>
  );
}
