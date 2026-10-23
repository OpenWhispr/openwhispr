import { EnterpriseAudioSettings } from "./EnterpriseAudioSettings";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Key, Cpu, Network, ShieldCheck } from "../icons";
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
import type { InferenceMode } from "../../types/electron";
import { useManagedScopeResolution } from "../../stores/enterpriseIdentityStore";
import { enterpriseProviderName } from "../../models/ModelRegistry";

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
    setEnterpriseTranscriptionSetupMode,
    enterpriseTranscriptionSetupMode,
    uploadRemoteTranscriptionUrl,
    setUploadRemoteTranscriptionUrl,
    uploadRemoteTranscriptionModel,
    setUploadRemoteTranscriptionModel,
  } = useSettingsStore();
  const managed = useManagedScopeResolution("transcription", enterpriseTranscriptionSetupMode);
  const managedActive = managed.kind === "managed";
  const managedRequired =
    managedActive && (managed.mode === "managed_required" || !managed.allowManualSetup);
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
      ...(managedActive || isEnterpriseTranscriptionOfferable(policySnapshot)
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
    if (mode === "openwhispr" && !isSignedIn) {
      requestSignIn();
      return;
    }
    setEnterpriseTranscriptionSetupMode(mode === "enterprise" ? "managed" : "manual");
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

  return (
    <div className="space-y-3">
      <EnterpriseAudioSettings />
      {managedActive && (
        <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
          <p className="text-sm font-medium">
            {t("settingsPage.aiModels.managedEnterprise.title")}
          </p>
          <p className="text-xs text-muted-foreground">
            {enterpriseProviderName(managed.provider)} · {managed.model}
          </p>
        </div>
      )}
      {managed.kind === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {managed.messageKey ? t(managed.messageKey) : managed.message}
        </p>
      ) : (
        <InferenceModeSelector
          modes={
            managedRequired
              ? transcriptionModes.filter((mode) => mode.id === "enterprise")
              : transcriptionModes
          }
          activeMode={managedActive ? "enterprise" : effectiveTranscriptionMode}
          onSelect={handleTranscriptionModeSelect}
        />
      )}

      {managed.kind === "manual" &&
        effectiveTranscriptionMode === "providers" &&
        renderTranscriptionPicker("cloud")}
      {managed.kind === "manual" &&
        effectiveTranscriptionMode === "local" &&
        renderTranscriptionPicker("local")}
      {managed.kind === "manual" && effectiveTranscriptionMode === "self-hosted" && (
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
