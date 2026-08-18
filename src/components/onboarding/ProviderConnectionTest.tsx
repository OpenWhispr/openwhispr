import { useEffect, useState } from "react";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

interface ProviderConnectionTestProps {
  config: Parameters<NonNullable<Window["electronAPI"]["testProviderConnection"]>>[0];
  onSuccessChange: (connected: boolean) => void;
  variant?: "default" | "inline";
}

export default function ProviderConnectionTest({
  config,
  onSuccessChange,
  variant = "default",
}: ProviderConnectionTestProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setStatus("idle");
    setError(null);
    onSuccessChange(false);
  }, [
    config.apiKey,
    config.baseUrl,
    config.clientId,
    config.clientSecret,
    config.environment,
    config.provider,
    config.scope,
    config.tenant,
    onSuccessChange,
  ]);

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

  if (variant === "inline") {
    return (
      <div>
        <div className="flex h-11 items-center justify-between rounded-xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-3">
          <span className="text-xs font-medium text-[var(--onboarding-text-primary)]">
            {t("onboarding.rehaul.provider.testConnection")}
          </span>
          <Button
            type="button"
            onClick={() => void testConnection()}
            disabled={status === "testing"}
            className="h-7 gap-1 rounded-full border-[var(--onboarding-inverse-surface)]! bg-[var(--onboarding-inverse-surface)] px-2 text-[0.5625rem] font-normal text-[var(--onboarding-inverse-text)] shadow-none! hover:bg-[var(--onboarding-inverse-surface-secondary)] focus-visible:ring-0 disabled:opacity-70"
          >
            {status === "testing" && <Loader2 className="size-3 animate-spin" />}
            {status === "success" && <CheckCircle className="size-3" />}
            {status === "error" && <XCircle className="size-3" />}
            {status === "testing"
              ? t("onboarding.rehaul.provider.testing")
              : status === "success"
                ? t("onboarding.rehaul.provider.connected")
                : t("onboarding.rehaul.provider.runTest")}
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-1 px-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  }

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
