import { useTranslation } from "react-i18next";
import { Input } from "./ui/input";

interface SelfHostedPanelProps {
  service: "transcription" | "reasoning";
  url: string;
  onUrlChange: (url: string) => void;
}

export default function SelfHostedPanel({ service, url, onUrlChange }: SelfHostedPanelProps) {
  const { t } = useTranslation();

  const placeholderUrl =
    service === "transcription" ? "http://192.168.1.126:8178" : "http://192.168.1.126:8080";

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
    </div>
  );
}
