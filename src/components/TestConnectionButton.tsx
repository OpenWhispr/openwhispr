import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { CheckCircle, XCircle, Loader2, Copy } from "lucide-react";

interface TestConnectionButtonProps {
  provider: string;
  getConfig: () => Record<string, string>;
}

export default function TestConnectionButton({ provider, getConfig }: TestConnectionButtonProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [errorInfo, setErrorInfo] = useState<{
    message: string;
    action?: string;
    copyCommand?: string;
  } | null>(null);

  const handleTest = async () => {
    setStatus("testing");
    setErrorInfo(null);
    try {
      const result = await window.electronAPI?.testEnterpriseConnection?.(provider, getConfig());
      if (result?.success) {
        setStatus("success");
        setTimeout(() => setStatus("idle"), 8000);
      } else {
        setStatus("error");
        setErrorInfo({
          message: result?.error || "Connection failed",
          action: result?.action,
          copyCommand: result?.copyCommand,
        });
      }
    } catch {
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
