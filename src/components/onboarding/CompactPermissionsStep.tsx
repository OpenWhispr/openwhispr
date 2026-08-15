import { useState } from "react";
import { Accessibility, Check, Mic, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UsePermissionsReturn } from "../../hooks/usePermissions";
import type { SystemAudioAccessResult } from "../../types/electron";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import { CompactOnboardingFrame } from "./OnboardingShell";

interface CompactPermissionsStepProps {
  permissions: UsePermissionsReturn;
  systemAudio: Pick<SystemAudioAccessResult, "granted" | "mode" | "supportsOnboardingGrant"> & {
    request: () => Promise<boolean>;
  };
  onContinue: () => void;
}

type PermissionRowId = "microphone" | "accessibility" | "system-audio";

interface PermissionRowProps {
  id: PermissionRowId;
  title: string;
  description: string;
  granted: boolean;
  busy: boolean;
  disabled?: boolean;
  icon: typeof Mic;
  iconClassName: string;
  onRequest: () => Promise<void>;
  onContinue?: () => void;
}

function PermissionRow({
  id,
  title,
  description,
  granted,
  busy,
  disabled = false,
  icon: Icon,
  iconClassName,
  onRequest,
  onContinue,
}: PermissionRowProps) {
  const { t } = useTranslation();
  const isPrimaryGate = id === "microphone";
  const canContinue = isPrimaryGate && granted && onContinue;

  return (
    <div className="flex h-[5.25rem] items-center gap-3.5">
      <div
        className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${iconClassName}`}
        aria-hidden="true"
      >
        {granted ? <Check className="size-5" strokeWidth={2.5} /> : <Icon className="size-6" />}
      </div>

      <div className="min-w-0 flex-1 text-left">
        <p className="text-base font-medium leading-5 text-neutral-950">{title}</p>
        <p className="mt-1 truncate text-sm leading-5 text-neutral-500">{description}</p>
      </div>

      <button
        type="button"
        disabled={busy || disabled || (granted && !canContinue)}
        onClick={() => (canContinue ? onContinue() : void onRequest())}
        className={`inline-flex h-9 min-w-[5.15rem] shrink-0 items-center justify-center rounded-full px-4 text-base font-normal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 disabled:cursor-default ${
          canContinue
            ? "bg-blue-500 text-white hover:bg-blue-600"
            : "bg-neutral-200 text-neutral-500 hover:bg-neutral-300 disabled:bg-neutral-200 disabled:text-neutral-500"
        }`}
      >
        {busy
          ? t("common.loading")
          : canContinue
            ? t("common.continue")
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
  onContinue,
}: CompactPermissionsStepProps) {
  const { t } = useTranslation();
  const [busyPermission, setBusyPermission] = useState<PermissionRowId | null>(null);
  const canRequestSystemAudio = canManageSystemAudioInApp(systemAudio);

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
      <div className="px-6 pt-48 text-center">
        <h1 className="onboarding-display-title mx-auto max-w-72">
          {t("onboarding.rehaul.permissions.title")}
        </h1>
        <p className="mt-4 text-base text-neutral-500">{t("auth.welcomeSubtitle")}</p>

        <div className="mt-[3.125rem] rounded-[1.35rem] bg-neutral-100 px-4 py-1.5">
          <PermissionRow
            id="microphone"
            title={t("onboarding.permissions.microphoneTitle")}
            description={t("onboarding.rehaul.permissions.microphoneDescription")}
            granted={permissions.micPermissionGranted}
            busy={busyPermission === "microphone"}
            icon={Mic}
            iconClassName="bg-blue-800 text-sky-400"
            onRequest={() => request("microphone", permissions.requestMicPermission)}
            onContinue={onContinue}
          />
          <div className="h-px bg-neutral-200" />
          <PermissionRow
            id="accessibility"
            title={t("onboarding.permissions.accessibilityTitle")}
            description={t("onboarding.rehaul.permissions.accessibilityDescription")}
            granted={permissions.accessibilityPermissionGranted}
            busy={busyPermission === "accessibility"}
            icon={Accessibility}
            iconClassName="bg-blue-500 text-white"
            onRequest={() => request("accessibility", permissions.requestAccessibilityPermission)}
          />
          <div className="h-px bg-neutral-200" />
          <PermissionRow
            id="system-audio"
            title={t("onboarding.rehaul.permissions.systemAudioTitle")}
            description={t("onboarding.rehaul.permissions.systemAudioDescription")}
            granted={systemAudio.granted}
            busy={busyPermission === "system-audio"}
            disabled={!canRequestSystemAudio}
            icon={Volume2}
            iconClassName="bg-red-400 text-white"
            onRequest={() => request("system-audio", systemAudio.request)}
          />
        </div>
      </div>
    </CompactOnboardingFrame>
  );
}
