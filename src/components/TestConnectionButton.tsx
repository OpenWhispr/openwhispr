import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { CheckCircle, XCircle, Loader2, Copy } from "lucide-react";

interface TestConnectionButtonProps {
  provider: string;
  getConfig: () => Record<string, unknown>;
  onStatusChange?: (connected: boolean) => void;
  variant?: "default" | "inline";
  disabled?: boolean;
  resetKey?: string;
}

export default function TestConnectionButton({
  provider,
  getConfig,
  onStatusChange,
  variant = "default",
  disabled = false,
  resetKey,
}: TestConnectionButtonProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [errorInfo, setErrorInfo] = useState<{
    message: string;
    action?: string;
    copyCommand?: string;
  } | null>(null);
  const requestIdRef = useRef(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    requestIdRef.current += 1;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    setStatus("idle");
    setErrorInfo(null);
    onStatusChange?.(false);
    return () => {
      requestIdRef.current += 1;
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [onStatusChange, resetKey]);

  const handleTest = async () => {
    const requestId = ++requestIdRef.current;
    setStatus("testing");
    onStatusChange?.(false);
    setErrorInfo(null);
    try {
      const result:
        | {
            success?: boolean;
            error?: string;
            action?: string;
            copyCommand?: string;
          }
        | undefined = await window.electronAPI?.testEnterpriseConnection?.(provider, getConfig());
      if (requestId !== requestIdRef.current) return;
      if (result?.success) {
        setStatus("success");
        onStatusChange?.(true);
        resetTimerRef.current = setTimeout(() => {
          if (requestId === requestIdRef.current) setStatus("idle");
        }, 8000);
      } else {
        setStatus("error");
        onStatusChange?.(false);
        setErrorInfo({
          message: result?.error || "Connection failed",
          action: result?.action,
          copyCommand: result?.copyCommand,
        });
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setStatus("error");
      onStatusChange?.(false);
      setErrorInfo({ message: "Connection test failed unexpectedly." });
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (variant === "inline") {
    return (
      <div className="space-y-2">
        {/* The inline variant only renders inside the onboarding canvas, so it
            uses the --onboarding-* tokens (like ProviderConnectionTest) instead
            of a hardcoded light palette that ignores dark mode. */}
        <div className="flex h-11 items-center justify-between rounded-xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-3">
          <span className="text-xs font-medium text-[var(--onboarding-text-primary)]">
            {t("onboarding.rehaul.enterprise.testConnection")}
          </span>
          <Button
            type="button"
            onClick={handleTest}
            disabled={disabled || status === "testing"}
            className="h-7 rounded-full border-[var(--onboarding-inverse-surface)]! bg-[var(--onboarding-inverse-surface)] px-3 text-[0.6875rem] font-normal text-[var(--onboarding-inverse-text)] shadow-none! hover:bg-[var(--onboarding-inverse-surface-secondary)] disabled:border-[var(--onboarding-surface-tertiary)]! disabled:bg-[var(--onboarding-surface-tertiary)] disabled:text-[var(--onboarding-text-tertiary)] disabled:opacity-100!"
          >
            {status === "testing" && <Loader2 className="mr-1.5 size-3 animate-spin" />}
            {status === "success" && <CheckCircle className="mr-1.5 size-3" />}
            {status === "error" && <XCircle className="mr-1.5 size-3" />}
            {status === "testing"
              ? t("reasoning.enterprise.testing", { defaultValue: "Testing..." })
              : status === "success"
                ? t("reasoning.enterprise.testSuccess", { defaultValue: "Connected" })
                : t("onboarding.rehaul.provider.runTest")}
          </Button>
        </div>

        {status === "error" && errorInfo && (
          <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-2.5">
            <p className="text-xs font-medium text-destructive">{errorInfo.message}</p>
            {errorInfo.action && (
              <p className="mt-1 text-xs text-muted-foreground">{errorInfo.action}</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 pt-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleTest}
        disabled={disabled || status === "testing"}
        className="w-full"
      >
        {status === "testing" && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
        {status === "success" && <CheckCircle className="w-3.5 h-3.5 mr-1.5 text-green-500" />}
        {status === "error" && <XCircle className="w-3.5 h-3.5 mr-1.5 text-destructive" />}
        {status === "testing"
          ? t("reasoning.enterprise.testing", { defaultValue: "Testing..." })
          : status === "success"
            ? t("reasoning.enterprise.testSuccess", { defaultValue: "Connected" })
            : t("reasoning.enterprise.testConnection", { defaultValue: "Test Connection" })}
      </Button>

      {status === "error" && errorInfo && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 p-2.5 space-y-1.5">
          <p className="text-xs text-destructive font-medium">{errorInfo.message}</p>
          {errorInfo.action && <p className="text-xs text-muted-foreground">{errorInfo.action}</p>}
          {errorInfo.copyCommand && (
            <div className="flex items-center gap-1.5">
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded flex-1 font-mono">
                {errorInfo.copyCommand}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 shrink-0"
                onClick={() => handleCopy(errorInfo.copyCommand!)}
              >
                <Copy className="w-3 h-3" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
