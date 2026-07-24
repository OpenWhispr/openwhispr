import { useTranslation } from "react-i18next";
import { Input } from "./ui/input";

interface SelfHostedPanelProps {
  service: "transcription" | "reasoning";
  url: string;
  onUrlChange: (url: string) => void;
  model?: string;
  onModelChange?: (model: string) => void;
}

export default function SelfHostedPanel({
  service,
  url,
  onUrlChange,
  model,
  onModelChange,
}: SelfHostedPanelProps) {
  const { t } = useTranslation();

  const placeholderUrl =
    service === "transcription" ? "http://127.0.0.1:8765" : "http://192.168.1.126:8080";

  return (
    <div className="border border-border rounded-lg p-3 space-y-2.5">
      <div className="space-y-1.5">
        <label className="block text-xs font-medium text-foreground">
          {t("settingsPage.selfHosted.serverUrl")}
        </label>
        <Input
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          placeholder={placeholderUrl}
          className="h-8 text-sm"
        />
      </div>
      {onModelChange && (
        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-foreground">{t("common.model")}</label>
          <Input
            value={model ?? ""}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder="Qwen/Qwen3-ASR-0.6B"
            className="h-8 text-sm"
          />
        </div>
      )}
    </div>
  );
}
