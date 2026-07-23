import React, { useState, useEffect, useRef, useCallback, useId } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, CheckCircle, Loader2, X, KeyRound } from "lucide-react";
import { Input } from "./input";
import logger from "../../utils/logger";
import type { LlmKeyValidationResult } from "../../types/electron";

interface ApiKeyInputProps {
  apiKey: string;
  setApiKey: (key: string) => void;
  className?: string;
  placeholder?: string;
  label?: string;
  ariaLabel?: string;
  helpText?: React.ReactNode;
  variant?: "default" | "purple";
  onSave?: (key: string) => Promise<LlmKeyValidationResult>;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "••••••••";
  return key.slice(0, 3) + "..." + key.slice(-4);
}

export default function ApiKeyInput({
  apiKey,
  setApiKey,
  className = "",
  placeholder,
  label,
  ariaLabel,
  helpText,
  variant = "default",
  onSave,
}: ApiKeyInputProps) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t("apiKeyInput.placeholder");
  const resolvedLabel = label ?? t("apiKeyInput.label");
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "testing" | "success" | "warning" | "error"
  >("idle");
  const [validationResult, setValidationResult] = useState<LlmKeyValidationResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const errorId = useId();
  const requestIdRef = useRef(0);
  const savingRef = useRef(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasKey = apiKey.length > 0;
  const variantClasses = variant === "purple" ? "border-primary focus:border-primary" : "";

  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing]);

  const enterEdit = () => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    setDraft(apiKey);
    setSaveStatus("idle");
    setValidationResult(null);
    setIsEditing(true);
  };

  const save = useCallback(async () => {
    if (savingRef.current) return;

    const normalized = draft.trim();
    if (normalized === apiKey.trim()) {
      setDraft("");
      setSaveStatus("idle");
      setValidationResult(null);
      setIsEditing(false);
      return;
    }

    if (!onSave) {
      try {
        setApiKey(normalized);
        setDraft("");
        setSaveStatus("idle");
        setValidationResult(null);
        setIsEditing(false);
      } catch (err) {
        logger.warn("Failed to save API key", { error: (err as Error).message }, "settings");
      }
      return;
    }

    const requestId = ++requestIdRef.current;
    savingRef.current = true;
    setSaveStatus("testing");
    setValidationResult(null);

    try {
      const result = await onSave(normalized);
      if (requestId !== requestIdRef.current) return;

      if (!result.success) {
        setSaveStatus("error");
        setValidationResult(result);
        return;
      }

      setDraft("");
      setIsEditing(false);
      if (normalized) {
        if (result.verified === false) {
          setSaveStatus("warning");
          setValidationResult(result);
        } else {
          setSaveStatus("success");
          successTimerRef.current = setTimeout(() => setSaveStatus("idle"), 5000);
        }
      } else {
        setSaveStatus("idle");
      }
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      logger.warn("Failed to validate API key", { error: (err as Error).message }, "settings");
      setSaveStatus("error");
      setValidationResult({
        success: false,
        provider: "",
        verified: false,
        code: "VALIDATION_FAILED",
        error: (err as Error).message,
        retryable: true,
      });
    } finally {
      if (requestId === requestIdRef.current) savingRef.current = false;
    }
  }, [apiKey, draft, onSave, setApiKey]);

  const cancel = () => {
    if (savingRef.current) return;
    requestIdRef.current += 1;
    setDraft("");
    setSaveStatus("idle");
    setValidationResult(null);
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  // Commit the draft instead of discarding it — users paste a key and click
  // the next field expecting it to stick (Escape or ✕ still cancels).
  useEffect(() => {
    if (!isEditing) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      save();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isEditing, save]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    },
    []
  );

  const resultMessage = validationResult?.code
    ? t(`apiKeyInput.errors.${validationResult.code}`, {
        defaultValue:
          validationResult.error ||
          validationResult.warning ||
          t("apiKeyInput.errors.VALIDATION_FAILED"),
      })
    : validationResult?.error || validationResult?.warning;
  const warningMessage = resultMessage
    ? t("apiKeyInput.savedUnverified", { reason: resultMessage })
    : t("apiKeyInput.savedUnverified", {
        reason: t("apiKeyInput.errors.VALIDATION_FAILED"),
      });

  return (
    <div ref={containerRef} className={className}>
      {resolvedLabel && (
        <label className="block text-xs font-medium text-foreground mb-1">{resolvedLabel}</label>
      )}

      <div className="relative">
        {isEditing ? (
          <div className="relative">
            <Input
              ref={inputRef}
              type="password"
              placeholder={resolvedPlaceholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={saveStatus === "testing"}
              aria-label={ariaLabel || resolvedLabel || t("apiKeyInput.label")}
              aria-invalid={saveStatus === "error"}
              aria-describedby={
                saveStatus === "error" || saveStatus === "warning" ? errorId : undefined
              }
              className={`h-8 text-sm font-mono pr-16 ${variantClasses}`}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <button
                type="button"
                onClick={save}
                disabled={saveStatus === "testing"}
                className="h-6 w-6 flex items-center justify-center rounded text-success hover:bg-success/10 active:scale-95 transition-all"
                aria-label={
                  saveStatus === "testing" ? t("apiKeyInput.testing") : t("apiKeyInput.save")
                }
              >
                {saveStatus === "testing" ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={saveStatus === "testing"}
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 active:scale-95 transition-all"
                aria-label={t("apiKeyInput.cancelEdit")}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={enterEdit}
            className={`w-full h-8 flex items-center px-3 rounded border text-sm transition-all cursor-pointer group ${
              hasKey
                ? "border-border/70 bg-input hover:border-border-hover dark:bg-surface-1 dark:border-border-subtle/50 dark:hover:border-border-hover"
                : "border-dashed border-border/40 bg-transparent hover:border-border/70 hover:bg-muted/30"
            }`}
            aria-label={hasKey ? t("apiKeyInput.edit") : t("apiKeyInput.add")}
          >
            {hasKey ? (
              <span className="flex items-center gap-1.5 text-foreground/70 font-mono text-xs tracking-wide">
                {saveStatus === "success" ? (
                  <CheckCircle className="w-3 h-3 text-success shrink-0" />
                ) : saveStatus === "warning" ? (
                  <AlertTriangle className="w-3 h-3 text-warning shrink-0" />
                ) : (
                  <KeyRound className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                )}
                {maskKey(apiKey)}
              </span>
            ) : (
              <span className="text-muted-foreground/40 text-xs">{resolvedPlaceholder}</span>
            )}
            <span className="ml-auto text-muted-foreground/30 text-xs group-hover:text-muted-foreground/60 transition-colors">
              {saveStatus === "success"
                ? t("apiKeyInput.verified")
                : saveStatus === "warning"
                  ? t("apiKeyInput.saved")
                  : hasKey
                    ? t("apiKeyInput.editButton")
                    : t("apiKeyInput.addButton")}
            </span>
          </button>
        )}
      </div>

      {saveStatus === "error" && resultMessage && (
        <div
          id={errorId}
          role="alert"
          aria-live="polite"
          className="flex items-center justify-between gap-2 mt-1"
        >
          <span className="text-xs text-destructive">{resultMessage}</span>
          {validationResult?.retryable && (
            <button
              type="button"
              onClick={save}
              className="text-xs font-medium text-destructive hover:underline shrink-0"
            >
              {t("common.retry")}
            </button>
          )}
        </div>
      )}
      {saveStatus === "warning" && (
        <p id={errorId} role="status" aria-live="polite" className="mt-1 text-xs text-warning">
          {warningMessage}
        </p>
      )}
      {helpText && <p className="text-xs text-muted-foreground/70 mt-1">{helpText}</p>}
    </div>
  );
}
