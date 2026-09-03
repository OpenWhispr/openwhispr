import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { CheckCircle, XCircle, Loader2, Copy } from "lucide-react";
import { TechnicalErrorDetails } from "./ui/TechnicalErrorDetails";
import type { TechnicalErrorDetailsData } from "./ui/useToast";

interface TestConnectionButtonProps {
  provider: string;
  getConfig: () => Record<string, unknown>;
}

export default function TestConnectionButton({ provider, getConfig }: TestConnectionButtonProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [errorInfo, setErrorInfo] = useState<{
    message: string;
    action?: string;
    copyCommand?: string;
    technicalDetails?: TechnicalErrorDetailsData;
  } | null>(null);
  const requestIdRef = useRef(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      requestIdRef.current += 1;
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const handleTest = async () => {
    const requestId = ++requestIdRef.current;
    setStatus("testing");
    setErrorInfo(null);
    try {
      const result = await window.electronAPI?.testEnterpriseConnection?.(provider, getConfig());
      if (requestId !== requestIdRef.current) return;
      if (result?.success) {
        setStatus("success");
        resetTimerRef.current = setTimeout(() => {
          if (requestId === requestIdRef.current) setStatus("idle");
        }, 8000);
      } else {
        setStatus("error");
        setErrorInfo({
          message: result?.messageKey
            ? t(result.messageKey, result.messageParams)
            : result?.error || t("reasoning.enterprise.testFailed"),
          action: result?.actionKey ? t(result.actionKey) : result?.action,
          copyCommand: result?.copyCommand,
          technicalDetails: result?.technicalDetails,
        });
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setStatus("error");
      setErrorInfo({ message: "Connection test failed unexpectedly." });
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="space-y-2 pt-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleTest}
        disabled={status === "testing"}
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
                aria-label={t("reasoning.enterprise.technicalDetails.copyCommand")}
              >
                <Copy className="w-3 h-3" />
              </Button>
            </div>
          )}
          <TechnicalErrorDetails details={errorInfo.technicalDetails} />
        </div>
      )}
    </div>
  );
}
