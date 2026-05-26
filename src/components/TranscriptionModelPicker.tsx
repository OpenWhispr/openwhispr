import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ProviderIcon } from "./ui/ProviderIcon";

interface TranscriptionModelPickerProps {
  selectedCloudProvider?: string;
  onCloudProviderSelect?: (providerId: string) => void;
  selectedCloudModel?: string;
  onCloudModelSelect?: (modelId: string) => void;
  selectedLocalModel?: string;
  onLocalModelSelect?: (modelId: string) => void;
  selectedLocalProvider?: string;
  onLocalProviderSelect?: (providerId: string) => void;
  useLocalWhisper?: boolean;
  onModeChange?: (useLocal: boolean) => void;
  cloudTranscriptionBaseUrl?: string;
  setCloudTranscriptionBaseUrl?: (url: string) => void;
  className?: string;
  variant?: "onboarding" | "settings";
  mode?: "cloud" | "local";
  streamingOnly?: boolean;
}

// Corti is the only supported STT provider. This component is intentionally
// minimal: it pins all transcription state to Corti and renders a single
// informational card.
export default function TranscriptionModelPicker({
  selectedCloudProvider,
  onCloudProviderSelect,
  selectedCloudModel,
  onCloudModelSelect,
  useLocalWhisper,
  onModeChange,
  className = "",
}: TranscriptionModelPickerProps) {
  const { t } = useTranslation();

  useEffect(() => {
    if (useLocalWhisper && onModeChange) onModeChange(false);
    if (selectedCloudProvider !== "corti" && onCloudProviderSelect) {
      onCloudProviderSelect("corti");
    }
    if (selectedCloudModel !== "transcribe" && onCloudModelSelect) {
      onCloudModelSelect("transcribe");
    }
  }, [
    useLocalWhisper,
    selectedCloudProvider,
    selectedCloudModel,
    onModeChange,
    onCloudProviderSelect,
    onCloudModelSelect,
  ]);

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-card p-4">
        <ProviderIcon provider="corti" className="w-8 h-8" />
        <div className="flex flex-col">
          <span className="font-medium text-foreground">Corti</span>
          <span className="text-xs text-muted-foreground">
            {t("transcription.cortiOnlyDescription", {
              defaultValue:
                "Corti Speech-to-Text is the active transcription engine. No additional provider selection is required.",
            })}
          </span>
        </div>
      </div>
    </div>
  );
}
