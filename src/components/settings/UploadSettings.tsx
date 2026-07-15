import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Cloud, Key, Cpu } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import { InferenceModeSelector } from "../ui/SettingsSection";
import type { InferenceModeOption } from "../ui/SettingsSection";
import TranscriptionModelPicker from "../TranscriptionModelPicker";
import type { InferenceMode } from "../../types/electron";
import { useStartOnboarding } from "../../hooks/useStartOnboarding";

export function UploadTranscriptionPanel() {
  const { t } = useTranslation();
  const startOnboarding = useStartOnboarding();

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
    uploadCloudTranscriptionProvider,
    setUploadCloudTranscriptionProvider,
    uploadCloudTranscriptionModel,
    setUploadCloudTranscriptionModel,
    uploadCloudTranscriptionBaseUrl,
    setUploadCloudTranscriptionBaseUrl,
    setUploadCloudTranscriptionMode,
  } = useSettingsStore();

  // Fork: hosted cloud modes removed — only on-device (local) and self-hosted
  // (your own OpenAI-compatible transcription endpoint).
  const transcriptionModes: InferenceModeOption[] = [
    {
      id: "local",
      label: t("settingsPage.transcription.modes.local"),
      description: t("settingsPage.transcription.modes.localDesc"),
      icon: <Cpu className="w-4 h-4" />,
    },
    {
      id: "providers",
      label: "Self-hosted",
      description: "Use your own OpenAI-compatible transcription endpoint",
      icon: <Key className="w-4 h-4" />,
    },
  ];

  const handleTranscriptionModeSelect = (mode: InferenceMode) => {
    if (mode === uploadTranscriptionMode) return;
    setUploadTranscriptionMode(mode);
    setUploadUseLocalWhisper(mode === "local");
    setUploadCloudTranscriptionMode("byok");
  };

  const handleLocalTranscriptionModelSelect = useCallback(
    (modelId: string) => {
      if (uploadLocalTranscriptionProvider === "nvidia") {
        setUploadParakeetModel(modelId);
      } else {
        setUploadWhisperModel(modelId);
      }
    },
    [uploadLocalTranscriptionProvider, setUploadParakeetModel, setUploadWhisperModel]
  );

  const renderTranscriptionPicker = (mode: "cloud" | "local") => (
    <TranscriptionModelPicker
      selectedCloudProvider={uploadCloudTranscriptionProvider}
      onCloudProviderSelect={setUploadCloudTranscriptionProvider}
      selectedCloudModel={uploadCloudTranscriptionModel}
      onCloudModelSelect={setUploadCloudTranscriptionModel}
      selectedLocalModel={
        uploadLocalTranscriptionProvider === "nvidia" ? uploadParakeetModel : uploadWhisperModel
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
        activeMode={uploadTranscriptionMode}
        onSelect={handleTranscriptionModeSelect}
      />

      {uploadTranscriptionMode === "providers" && renderTranscriptionPicker("cloud")}
      {uploadTranscriptionMode === "local" && renderTranscriptionPicker("local")}
    </div>
  );
}
