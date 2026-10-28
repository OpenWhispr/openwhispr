import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Key, Cpu, Network, ShieldCheck, AlertTriangle } from "../icons";
import {
  TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS,
  TRANSCRIPTION_POLICY_PROVIDER_IDS,
  useSettingsStore,
} from "../../stores/settingsStore";
import { usePolicyModeOptions, usePolicySnapshot } from "../../hooks/usePolicy";
import { isEnterpriseTranscriptionOfferable } from "../../stores/policyRules";
import { requestSignIn } from "../../utils/requestSignIn";
import { InferenceModeSelector } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import SelfHostedPanel from "../SelfHostedPanel";
import { Button } from "../ui/button";
import { enterpriseProviderName } from "../../models/ModelRegistry";
import { useManagedScopeResolution } from "../../stores/enterpriseIdentityStore";
import type { InferenceMode } from "../../types/electron";

export function UploadTranscriptionPanel() {
  const { t } = useTranslation();
  const policySnapshot = usePolicySnapshot();

  const {
    isSignedIn,
    uploadTranscriptionMode,
    setUploadTranscriptionMode,
    setUploadUseLocalWhisper,
    uploadWhisperModel,
    setUploadWhisperModel,
    uploadLocalTranscriptionProvider,
    setUploadLocalTranscriptionProvider,
    uploadParakeetModel,
    setUploadParakeetModel,
    uploadCohereModel,
    setUploadCohereModel,
    uploadCloudTranscriptionProvider,
    setUploadCloudTranscriptionProvider,
    uploadCloudTranscriptionModel,
    setUploadCloudTranscriptionModel,
    uploadCloudTranscriptionBaseUrl,
    setUploadCloudTranscriptionBaseUrl,
    setUploadCloudTranscriptionMode,
    enterpriseTranscriptionSetupMode,
    setEnterpriseTranscriptionSetupMode,
    uploadRemoteTranscriptionUrl,
    setUploadRemoteTranscriptionUrl,
    uploadRemoteTranscriptionModel,
    setUploadRemoteTranscriptionModel,
  } = useSettingsStore();
  const managed = useManagedScopeResolution("transcription", enterpriseTranscriptionSetupMode);
  const managedAvailable = useManagedScopeResolution("transcription", "managed");
  const {
    modes: transcriptionModes,
    effectiveMode: effectiveTranscriptionMode,
    isModeAllowed,
  } = usePolicyModeOptions<InferenceModeOption>(
    [
      {
        id: "openwhispr",
        label: t("settingsPage.transcription.modes.openwhispr"),
        description: t("settingsPage.transcription.modes.openwhisprDesc"),
        icon: <Cloud className="w-4 h-4" />,
        disabled: !isSignedIn,
        signInRequired: !isSignedIn,
      },
      {
        id: "providers",
        label: t("settingsPage.transcription.modes.providers"),
        description: t("settingsPage.transcription.modes.providersDesc"),
        icon: <Key className="w-4 h-4" />,
      },
      {
        id: "local",
        label: t("settingsPage.transcription.modes.local"),
        description: t("settingsPage.transcription.modes.localDesc"),
        icon: <Cpu className="w-4 h-4" />,
      },
      {
        id: "self-hosted",
        label: t("settingsPage.transcription.modes.selfHosted"),
        description: t("settingsPage.transcription.modes.selfHostedDesc"),
        icon: <Network className="w-4 h-4" />,
      },
      ...(isEnterpriseTranscriptionOfferable(policySnapshot) && managedAvailable.kind === "managed"
        ? [
            {
              id: "enterprise" as const,
              label: t("settingsPage.transcription.modes.enterprise"),
              description: t("settingsPage.transcription.modes.enterpriseDesc"),
              icon: <ShieldCheck className="w-4 h-4" />,
            },
          ]
        : []),
    ],
    "transcription",
    uploadTranscriptionMode,
    {
      byokProviders: TRANSCRIPTION_POLICY_PROVIDER_IDS,
      enterpriseProviders: TRANSCRIPTION_ENTERPRISE_POLICY_PROVIDER_IDS,
    }
  );
  const handleTranscriptionModeSelect = (mode: InferenceMode) => {
    if (!isModeAllowed(mode)) return;
    if (mode === "enterprise") {
      if (managedAvailable.kind !== "managed") return;
      setEnterpriseTranscriptionSetupMode("managed");
      return;
    }
    if (mode === "openwhispr" && !isSignedIn) {
      requestSignIn();
      return;
    }
    if (mode === effectiveTranscriptionMode) return;
    setUploadTranscriptionMode(mode);
    setUploadUseLocalWhisper(mode === "local");
    setUploadCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
  };

  const handleLocalTranscriptionModelSelect = useCallback(
    (modelId: string, providerId?: string) => {
      const provider = providerId ?? uploadLocalTranscriptionProvider;
      if (provider === "nvidia") {
        setUploadParakeetModel(modelId);
      } else if (provider === "cohere") {
        setUploadCohereModel(modelId);
      } else {
        setUploadWhisperModel(modelId);
      }
    },
    [
      uploadLocalTranscriptionProvider,
      setUploadParakeetModel,
      setUploadCohereModel,
      setUploadWhisperModel,
    ]
  );

  const renderTranscriptionPicker = (mode: "cloud" | "local") => (
    <TranscriptionModelPicker
      transcriptionContext="upload"
      selectedCloudProvider={uploadCloudTranscriptionProvider}
      onCloudProviderSelect={setUploadCloudTranscriptionProvider}
      selectedCloudModel={uploadCloudTranscriptionModel}
      onCloudModelSelect={setUploadCloudTranscriptionModel}
      selectedLocalModel={
        uploadLocalTranscriptionProvider === "nvidia"
          ? uploadParakeetModel
          : uploadLocalTranscriptionProvider === "cohere"
            ? uploadCohereModel
            : uploadWhisperModel
      }
      onLocalModelSelect={handleLocalTranscriptionModelSelect}
      selectedLocalProvider={uploadLocalTranscriptionProvider}
      onLocalProviderSelect={setUploadLocalTranscriptionProvider}
      useLocalWhisper={mode === "local"}
      onModeChange={() => {}}
      mode={mode}
      cloudTranscriptionBaseUrl={uploadCloudTranscriptionBaseUrl}
      setCloudTranscriptionBaseUrl={setUploadCloudTranscriptionBaseUrl}
      variant="settings"
    />
  );

  const errorCard =
    managed.kind === "error" ? (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3" role="alert">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="text-sm font-medium">
              {t("settingsPage.aiModels.managedEnterprise.errorTitle")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {managed.messageKey ? t(managed.messageKey) : managed.message}
            </p>
          </div>
        </div>
      </div>
    ) : null;

  const managedCard =
    managed.kind === "managed" ? (
      <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
        <div className="flex items-start gap-2.5">
          <div className="rounded-md bg-primary/10 p-1.5 text-primary">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {t("settingsPage.aiModels.managedEnterprise.title")}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {enterpriseProviderName(managed.provider)} ·{" "}
              <span className="font-mono">{managed.model}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("settingsPage.aiModels.managedEnterprise.description")}
            </p>
          </div>
        </div>
        {managed.mode !== "managed_required" && managed.allowManualSetup && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEnterpriseTranscriptionSetupMode("manual")}
            >
              {t("settingsPage.aiModels.managedEnterprise.usePersonalSetup")}
            </Button>
          </div>
        )}
      </div>
    ) : null;

  if (errorCard) return errorCard;
  if (managedCard) return managedCard;

  return (
    <div className="space-y-3">
      {enterpriseTranscriptionSetupMode === "manual" && managedAvailable.kind === "managed" && (
        <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {t("settingsPage.aiModels.managedEnterprise.availableTitle")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settingsPage.aiModels.managedEnterprise.availableDescription", {
                provider: enterpriseProviderName(managedAvailable.provider),
              })}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setEnterpriseTranscriptionSetupMode("managed")}
          >
            {t("settingsPage.aiModels.managedEnterprise.useManaged")}
          </Button>
        </div>
      )}
      <InferenceModeSelector
        modes={transcriptionModes}
        activeMode={effectiveTranscriptionMode}
        onSelect={handleTranscriptionModeSelect}
      />

      {effectiveTranscriptionMode === "providers" && renderTranscriptionPicker("cloud")}
      {effectiveTranscriptionMode === "local" && renderTranscriptionPicker("local")}
      {effectiveTranscriptionMode === "self-hosted" && (
        <SelfHostedPanel
          service="transcription"
          url={uploadRemoteTranscriptionUrl}
          onUrlChange={setUploadRemoteTranscriptionUrl}
          model={uploadRemoteTranscriptionModel}
          onModelChange={setUploadRemoteTranscriptionModel}
        />
      )}
    </div>
  );
}
