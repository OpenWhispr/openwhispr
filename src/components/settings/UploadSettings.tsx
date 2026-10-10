import { useCallback } from "react";
import type { SettingsNavigationStore } from "../../stores/settingsNavigationStore";
import { useShallow } from "zustand/react/shallow";
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

export function UploadTranscriptionPanel({ navigation }: { navigation?: SettingsNavigationStore }) {
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
    uploadRemoteTranscriptionUrl,
    setUploadRemoteTranscriptionUrl,
    uploadRemoteTranscriptionModel,
    setUploadRemoteTranscriptionModel,
  } = useSettingsStore(
    useShallow((s) => ({
      isSignedIn: s.isSignedIn,
      uploadTranscriptionMode: s.uploadTranscriptionMode,
      setUploadTranscriptionMode: s.setUploadTranscriptionMode,
      setUploadUseLocalWhisper: s.setUploadUseLocalWhisper,
      uploadWhisperModel: s.uploadWhisperModel,
      setUploadWhisperModel: s.setUploadWhisperModel,
      uploadLocalTranscriptionProvider: s.uploadLocalTranscriptionProvider,
      setUploadLocalTranscriptionProvider: s.setUploadLocalTranscriptionProvider,
      uploadParakeetModel: s.uploadParakeetModel,
      setUploadParakeetModel: s.setUploadParakeetModel,
      uploadCohereModel: s.uploadCohereModel,
      setUploadCohereModel: s.setUploadCohereModel,
      uploadCloudTranscriptionProvider: s.uploadCloudTranscriptionProvider,
      setUploadCloudTranscriptionProvider: s.setUploadCloudTranscriptionProvider,
      uploadCloudTranscriptionModel: s.uploadCloudTranscriptionModel,
      setUploadCloudTranscriptionModel: s.setUploadCloudTranscriptionModel,
      uploadCloudTranscriptionBaseUrl: s.uploadCloudTranscriptionBaseUrl,
      setUploadCloudTranscriptionBaseUrl: s.setUploadCloudTranscriptionBaseUrl,
      setUploadCloudTranscriptionMode: s.setUploadCloudTranscriptionMode,
      setEnterpriseTranscriptionSetupMode: s.setEnterpriseTranscriptionSetupMode,
      uploadRemoteTranscriptionUrl: s.uploadRemoteTranscriptionUrl,
      setUploadRemoteTranscriptionUrl: s.setUploadRemoteTranscriptionUrl,
      uploadRemoteTranscriptionModel: s.uploadRemoteTranscriptionModel,
      setUploadRemoteTranscriptionModel: s.setUploadRemoteTranscriptionModel,
    }))
  );
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
      ...(isEnterpriseTranscriptionOfferable(policySnapshot)
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
    if (mode === effectiveTranscriptionMode) return;
    setUploadTranscriptionMode(mode);
    setUploadUseLocalWhisper(mode === "local");
    setUploadCloudTranscriptionMode(mode === "openwhispr" ? "openwhispr" : "byok");
    if (mode === "enterprise") setEnterpriseTranscriptionSetupMode("managed");
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
      settingsNavigation={navigation}
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
