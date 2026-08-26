import { useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
// Imported (not referenced by path) so Vite fingerprints them and they resolve
// under the packaged app's file:// origin. Authored at 88px (2x the original
// 44px slot; the row has since tightened to a 40px slot), with their rounded
// corners baked in as transparency.
import microphoneIcon from "@/assets/onboarding-permission-microphone.webp";
import accessibilityIcon from "@/assets/onboarding-permission-accessibility.webp";
import systemAudioIcon from "@/assets/onboarding-permission-system-audio.webp";
import screenContextIcon from "@/assets/onboarding-permission-screen-context.webp";
import type { UsePermissionsReturn } from "../../hooks/usePermissions";
import type { SystemAudioAccessResult } from "../../types/electron";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import { getPlatform } from "../../utils/platform";
import { areRequiredPermissionsMet } from "../../utils/permissions";
import { needsLinuxPasteToolGuidance } from "../../utils/linuxPasteTools";
import MicPermissionWarning from "../ui/MicPermissionWarning";
import PasteToolsInfo from "../ui/PasteToolsInfo";
import { CompactOnboardingFrame } from "./OnboardingShell";

interface CompactPermissionsStepProps {
  permissions: UsePermissionsReturn;
  systemAudio: Pick<SystemAudioAccessResult, "granted" | "mode" | "supportsOnboardingGrant"> & {
    request: () => Promise<boolean>;
  };
  screenContext?: {
    enabled: boolean;
    granted: boolean;
    needsRelaunch: boolean;
    request: () => Promise<boolean>;
  };
  onContinue: () => void;
}

type PermissionRowId = "microphone" | "accessibility" | "system-audio" | "screen-context";

interface PermissionRowProps {
  title: string;
  description: string;
  granted: boolean;
  busy: boolean;
  disabled?: boolean;
  iconSrc: string;
  onRequest: () => Promise<void>;
}

function PermissionRow({
  title,
  description,
  granted,
  busy,
  disabled = false,
  iconSrc,
  onRequest,
}: PermissionRowProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-16 items-center gap-3">
      {/* Decorative: the adjacent title and description already name the
          permission, so announcing the icon too would just duplicate it. The
          icon stays put once granted — the button carries the state. */}
      <img
        src={iconSrc}
        alt=""
        aria-hidden="true"
        width={40}
        height={40}
        decoding="async"
        draggable={false}
        className="size-10 shrink-0 select-none"
      />

      <div className="min-w-0 flex-1 text-left">
        <p className="text-sm font-medium leading-5 text-[var(--onboarding-text-primary)]">
          {title}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-4 text-[var(--onboarding-text-secondary)]">
          {description}
        </p>
      </div>

      <button
        type="button"
        disabled={busy || disabled || granted}
        onClick={() => void onRequest()}
        className={`onboarding-pressable inline-flex h-8 min-w-20 shrink-0 items-center justify-center gap-1 rounded-full px-2.5 text-xs font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--onboarding-accent)_30%,transparent)] disabled:cursor-default ${
          granted
            ? // Granted rows are disabled, so the disabled: variants have to
              // restate the tint or it falls back to the neutral grey below.
              "bg-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] text-[var(--onboarding-accent)] disabled:bg-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] disabled:text-[var(--onboarding-accent)]"
            : "bg-[var(--onboarding-surface-tertiary)] text-[var(--onboarding-text-secondary)] hover:bg-[var(--onboarding-surface-tertiary-hover)] disabled:bg-[var(--onboarding-surface-tertiary)] disabled:text-[var(--onboarding-text-secondary)]"
        }`}
      >
        {granted && !busy && <CircleCheck className="size-3.5 shrink-0" aria-hidden="true" />}
        {busy
          ? t("common.loading")
          : granted
            ? t("onboarding.rehaul.permissions.enabled")
            : t("onboarding.rehaul.permissions.enable")}
      </button>
    </div>
  );
}

export default function CompactPermissionsStep({
  permissions,
  systemAudio,
  screenContext,
  onContinue,
}: CompactPermissionsStepProps) {
  const { t } = useTranslation();
  const [busyPermission, setBusyPermission] = useState<PermissionRowId | null>(null);
  const platform = getPlatform();
  const canRequestSystemAudio = canManageSystemAudioInApp(systemAudio);
  const requiredGranted = areRequiredPermissionsMet(permissions.micPermissionGranted);
  // Only macOS has grantable Accessibility (auto-paste) and System Audio
  // permissions. Windows auto-grants both (SendKeys needs nothing, WASAPI
  // loopback is permissionless) and Linux has no in-app grant for either, so
  // showing those rows there is either a no-op button or a dead disabled one.
  const showAccessibility = platform === "darwin";
  const showSystemAudio = platform === "darwin";
  // Screen Context: macOS grants via TCC, Windows is a permissionless opt-in;
  // Linux is hidden because Wayland capture is unsupported.
  const showScreenContext = platform === "darwin" || platform === "win32";
  const showLinuxPasteGuidance =
    platform === "linux" &&
    permissions.pasteToolsInfo !== null &&
    needsLinuxPasteToolGuidance(permissions.pasteToolsInfo);

  const request = async (id: PermissionRowId, action: () => Promise<unknown>) => {
    setBusyPermission(id);
    try {
      await action();
    } finally {
      setBusyPermission(null);
    }
  };

  return (
    <CompactOnboardingFrame showLegalNotice={false}>
      {/* Continue appears once the required permission (microphone) is granted.
          Portalled to body: inside the step wrapper it can never out-stack the
          shell's z-50 drag band (see OnboardingShell), so clicks would be
          swallowed as window drags. */}
      {requiredGranted &&
        createPortal(
          <button
            type="button"
            onClick={onContinue}
            // Literal white, not tokens: this sits on the indigo hero, which
            // stays indigo in both themes.
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            className={`onboarding-pressable fixed top-4 z-[60] h-7 rounded-full bg-white px-3 text-xs font-medium text-neutral-950 transition-colors hover:bg-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${platform === "darwin" ? "right-4" : "right-24"}`}
          >
            {t("common.continue")}
          </button>,
          document.body
        )}

      <div className="onboarding-shell-scroll h-full overflow-y-auto px-5 pb-4 pt-44 text-center">
        {/* text-balance evens the two lines out ("Set up OpenWhispr" / "in 3
            minutes") instead of leaving one word stranded. Preferred over a
            hardcoded <br> because the break point stays correct in all 9
            locales, where the string length differs. */}
        <h1 className="onboarding-display-title mx-auto max-w-72 text-balance text-3xl!">
          {t("onboarding.rehaul.permissions.title")}
        </h1>
        <p className="mt-2 text-sm text-[var(--onboarding-text-secondary)]">
          {t("auth.welcomeSubtitle")}
        </p>

        <div className="mt-8 rounded-[1.35rem] bg-[var(--onboarding-surface-secondary)] px-3 py-1">
          <PermissionRow
            title={t("onboarding.permissions.microphoneTitle")}
            description={t("onboarding.rehaul.permissions.microphoneDescription")}
            granted={permissions.micPermissionGranted}
            busy={busyPermission === "microphone"}
            iconSrc={microphoneIcon}
            onRequest={() => request("microphone", permissions.requestMicPermission)}
          />
          {showAccessibility && (
            <>
              <div className="h-px bg-[var(--onboarding-surface-tertiary)]" />
              <PermissionRow
                title={t("onboarding.permissions.accessibilityTitle")}
                description={t("onboarding.rehaul.permissions.accessibilityDescription")}
                granted={permissions.accessibilityPermissionGranted}
                busy={busyPermission === "accessibility"}
                iconSrc={accessibilityIcon}
                onRequest={() =>
                  request("accessibility", permissions.requestAccessibilityPermission)
                }
              />
            </>
          )}
          {showSystemAudio && (
            <>
              <div className="h-px bg-[var(--onboarding-surface-tertiary)]" />
              <PermissionRow
                title={t("onboarding.rehaul.permissions.systemAudioTitle")}
                description={t("onboarding.rehaul.permissions.systemAudioDescription")}
                granted={systemAudio.granted}
                busy={busyPermission === "system-audio"}
                disabled={!canRequestSystemAudio}
                iconSrc={systemAudioIcon}
                onRequest={() => request("system-audio", systemAudio.request)}
              />
            </>
          )}
          {showScreenContext && screenContext && (
            <>
              <div className="h-px bg-[var(--onboarding-surface-tertiary)]" />
              <PermissionRow
                title={t("dictationAgent.screenContext.title")}
                description={t("onboarding.rehaul.permissions.screenContextDescription")}
                granted={screenContext.enabled && screenContext.granted}
                busy={busyPermission === "screen-context"}
                iconSrc={screenContextIcon}
                onRequest={() => request("screen-context", screenContext.request)}
              />
            </>
          )}
        </div>

        {platform === "darwin" && screenContext?.enabled && screenContext.needsRelaunch && (
          <p className="mt-2 text-left text-xs leading-4 text-warning/80">
            {t("dictationAgent.screenContext.relaunchHint")}
          </p>
        )}

        {!permissions.micPermissionGranted && permissions.micPermissionError && (
          <div className="mt-3 text-left">
            <MicPermissionWarning
              error={permissions.micPermissionError}
              onOpenSoundSettings={() => void permissions.openSoundInputSettings()}
              onOpenPrivacySettings={() => void permissions.openMicPrivacySettings()}
            />
          </div>
        )}

        {showLinuxPasteGuidance && (
          <div className="mt-3 text-left">
            <PasteToolsInfo
              pasteToolsInfo={permissions.pasteToolsInfo}
              isChecking={permissions.isCheckingPasteTools}
              onCheck={() => void permissions.checkPasteToolsAvailability()}
            />
          </div>
        )}
      </div>
    </CompactOnboardingFrame>
  );
}
