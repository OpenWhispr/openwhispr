import { useEffect, useState } from "react";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

interface ProviderConnectionTestProps {
  config: Parameters<NonNullable<Window["electronAPI"]["testProviderConnection"]>>[0];
  onSuccessChange: (connected: boolean) => void;
}

export default function ProviderConnectionTest({
  config,
  onSuccessChange,
}: ProviderConnectionTestProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStatus("idle");
    setError(null);
    onSuccessChange(false);
  }, [config.apiKey, config.baseUrl, config.provider, config.scope, onSuccessChange]);

  const testConnection = async () => {
    setStatus("testing");
    setError(null);
    onSuccessChange(false);
    try {
      const result = await window.electronAPI?.testProviderConnection?.(config);
      if (result?.success) {
        setStatus("success");
        onSuccessChange(true);
      } else {
        setStatus("error");
        setError(result?.error ?? t("onboarding.rehaul.provider.connectionFailed"));
      }
    } catch {
      setStatus("error");
      setError(t("onboarding.rehaul.provider.connectionFailed"));
    }
  };

  return (
    <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
      <Button
        type="button"
        variant="outline"
        onClick={() => void testConnection()}
        disabled={status === "testing"}
        className="w-full rounded-lg"
      >
        {status === "testing" && <Loader2 className="size-4 animate-spin" />}
        {status === "success" && <CheckCircle className="size-4 text-success" />}
        {status === "error" && <XCircle className="size-4 text-destructive" />}
        {status === "testing"
          ? t("onboarding.rehaul.provider.testing")
          : status === "success"
            ? t("onboarding.rehaul.provider.connected")
            : t("onboarding.rehaul.provider.runTest")}
      </Button>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
