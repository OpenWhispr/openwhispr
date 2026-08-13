import { useTranslation } from "react-i18next";
import { Mic, Shield, Monitor } from "lucide-react";
import PermissionCard from "./PermissionCard";
import MicPermissionWarning from "./MicPermissionWarning";
import PasteToolsInfo from "./PasteToolsInfo";
import type { UsePermissionsReturn } from "../../hooks/usePermissions";
import type { SystemAudioAccessResult } from "../../types/electron";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";

interface PermissionsSectionProps {
  permissions: UsePermissionsReturn;
  systemAudio: Pick<SystemAudioAccessResult, "granted" | "mode" | "supportsOnboardingGrant"> & {
    request: () => Promise<boolean>;
  };
  /** Badge system audio as "Recommended" (e.g. when the user came for meeting notes). */
  systemAudioRecommended?: boolean;
}

export default function PermissionsSection({
  permissions,
  systemAudio,
  systemAudioRecommended = false,
}: PermissionsSectionProps) {
  const { t } = useTranslation();
  const platform = permissions.pasteToolsInfo?.platform;
  const isMacOS = platform === "darwin";
  const shouldShowSystemAudioPermission = canManageSystemAudioInApp(systemAudio);

  return (
    <>
      <div className="space-y-1.5">
        <PermissionCard
          icon={Mic}
          title={t("onboarding.permissions.microphoneTitle")}
          description={t("onboarding.permissions.microphoneDescription")}
          granted={permissions.micPermissionGranted}
          onRequest={permissions.requestMicPermission}
          buttonText={t("onboarding.permissions.grantAccess")}
        />

        {isMacOS && (
          <PermissionCard
            icon={Shield}
            title={t("onboarding.permissions.accessibilityTitle")}
            description={t("onboarding.permissions.accessibilityDescription")}
            granted={permissions.accessibilityPermissionGranted}
            onRequest={permissions.requestAccessibilityPermission}
            buttonText={t("onboarding.permissions.grantAccess")}
            badge={t("onboarding.permissions.recommended")}
            hint={
              permissions.accessibilityTroubleshooting
                ? t("onboarding.permissions.accessibilityTroubleshooting")
                : undefined
            }
          />
        )}

        {shouldShowSystemAudioPermission && (
          <PermissionCard
            icon={Monitor}
            title={t("onboarding.permissions.systemAudioTitle")}
            description={t("onboarding.permissions.systemAudioDescription")}
            granted={systemAudio.granted}
            onRequest={systemAudio.request}
            buttonText={t("onboarding.permissions.grantAccess")}
            badge={
              systemAudioRecommended
                ? t("onboarding.permissions.recommended")
                : t("onboarding.permissions.optional")
            }
          />
        )}
      </div>

      {!permissions.micPermissionGranted && permissions.micPermissionError && (
        <MicPermissionWarning
          error={permissions.micPermissionError}
          onOpenSoundSettings={permissions.openSoundInputSettings}
          onOpenPrivacySettings={permissions.openMicPrivacySettings}
        />
      )}

      {platform === "linux" &&
        permissions.pasteToolsInfo &&
        !permissions.pasteToolsInfo.available && (
          <PasteToolsInfo
            pasteToolsInfo={permissions.pasteToolsInfo}
            isChecking={permissions.isCheckingPasteTools}
            onCheck={permissions.checkPasteToolsAvailability}
          />
        )}
    </>
  );
}
