import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { CheckCircle, XCircle, Loader2, Copy } from "./icons";
import { TechnicalErrorDetails } from "./ui/TechnicalErrorDetails";
import type { TechnicalErrorDetailsData } from "./ui/useToast";

import {
  getAuthRequestContextSnapshot,
  getAuthRequestContextServerSnapshot,
  subscribeAuthRequestContext,
} from "../lib/authRequestContext";

interface TestConnectionButtonProps {
  provider: string;
  getConfig: () => Record<string, unknown>;
  /** Semantic, memory-only identity; callback identity is not configuration. */
  configurationKey: string;
}

export default function TestConnectionButton({
  provider,
  getConfig,
  configurationKey,
}: TestConnectionButtonProps) {
  const { t } = useTranslation();
  const auth = useSyncExternalStore(
    subscribeAuthRequestContext,
    getAuthRequestContextSnapshot,
    getAuthRequestContextServerSnapshot
  );
  const owner = JSON.stringify([
    provider,
    configurationKey,
    auth.sessionUserId,
    auth.observedGeneration,
    auth.validatedGeneration,
  ]);
  const [feedback, setFeedback] = useState<{
    owner: string;
    status: "idle" | "testing" | "success" | "error";
  }>({ owner, status: "idle" });
  const status = feedback.owner === owner ? feedback.status : "idle";
  const setStatus = (status: typeof feedback.status) => setFeedback({ owner, status });
  const [errorInfo, setErrorInfo] = useState<{
    message?: string;
    messageKey?: string;
    messageParams?: Record<string, unknown>;
    action?: string;
    actionKey?: string;
    copyCommand?: string;
    technicalDetails?: TechnicalErrorDetailsData;
  } | null>(null);
  const requestIdRef = useRef(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (feedback.owner !== owner) {
    setFeedback({ owner, status: "idle" });
    setErrorInfo(null);
  }
  const liveOwnerRef = useRef<string | null>(null);
  const bindFeedback = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      liveOwnerRef.current = owner;
      return () => {
        liveOwnerRef.current = null;
        requestIdRef.current += 1;
        if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      };
    },
    [owner]
  );

  const handleTest = async () => {
    if (liveOwnerRef.current !== owner) return;
    const requestId = ++requestIdRef.current;
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
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
          message: result?.error,
          messageKey:
            result?.messageKey || (!result?.error ? "reasoning.enterprise.testFailed" : undefined),
          messageParams: result?.messageParams,
          action: result?.action,
          actionKey: result?.actionKey,
          copyCommand: result?.copyCommand,
          technicalDetails: result?.technicalDetails,
        });
      }
    } catch {
      if (requestId !== requestIdRef.current) return;
      setStatus("error");
      setErrorInfo({ messageKey: "reasoning.enterprise.testFailed" });
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div ref={bindFeedback} className="space-y-2 pt-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleTest}
        disabled={status === "testing"}
        className="w-full"
      >
        {status === "testing" && <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />}
        {status === "success" && <CheckCircle className="w-3.5 h-3.5 me-1.5 text-green-500" />}
        {status === "error" && <XCircle className="w-3.5 h-3.5 me-1.5 text-destructive" />}
        {status === "testing"
          ? t("reasoning.enterprise.testing", { defaultValue: "Testing..." })
          : status === "success"
            ? t("reasoning.enterprise.testSuccess", { defaultValue: "Connected" })
            : t("reasoning.enterprise.testConnection", { defaultValue: "Test Connection" })}
      </Button>

      {status === "error" && errorInfo && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 p-2.5 space-y-1.5">
          <p dir="auto" className="text-xs text-destructive font-medium">
            {errorInfo.messageKey
              ? t(errorInfo.messageKey, errorInfo.messageParams)
              : errorInfo.message}
          </p>
          {(errorInfo.actionKey || errorInfo.action) && (
            <p dir="auto" className="text-xs text-muted-foreground">
              {errorInfo.actionKey ? t(errorInfo.actionKey) : errorInfo.action}
            </p>
          )}
          {errorInfo.copyCommand && (
            <div className="flex items-center gap-1.5">
              <code dir="ltr" className="text-xs bg-muted px-1.5 py-0.5 rounded flex-1 font-mono">
                {errorInfo.copyCommand}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
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
