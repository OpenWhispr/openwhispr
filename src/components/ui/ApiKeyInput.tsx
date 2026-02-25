import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Check, X, KeyRound } from "lucide-react";
import { Input } from "./input";
import logger from "../../utils/logger";

interface ApiKeyInputProps {
  apiKey: string;
  setApiKey: (key: string) => void;
  className?: string;
  placeholder?: string;
  label?: string;
  ariaLabel?: string;
  helpText?: React.ReactNode;
  variant?: "default" | "purple";
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
}: ApiKeyInputProps) {
  const { t } = useTranslation();
  const resolvedPlaceholder = placeholder ?? t("apiKeyInput.placeholder");
  const resolvedLabel = label ?? t("apiKeyInput.label");
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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
    setDraft(apiKey);
    setIsEditing(true);
  };

  const save = () => {
    try {
      setApiKey(draft.trim());
    } catch (err) {
      logger.warn("Failed to save API key", { error: (err as Error).message }, "settings");
    }
    setIsEditing(false);
  };

  const cancel = () => {
    setDraft("");
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

  useEffect(() => {
    if (!isEditing) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      cancel();
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isEditing]);

  return (
    <div className={className}>
      {resolvedLabel && (
        <label className="block text-xs font-medium text-foreground mb-1">{resolvedLabel}</label>
      )}

      <div ref={containerRef} className="relative">
        {isEditing ? (
          <div className="relative">
            <Input
              ref={inputRef}
              type="text"
              placeholder={resolvedPlaceholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              aria-label={ariaLabel || resolvedLabel || t("apiKeyInput.label")}
              className={`h-8 text-sm font-mono pr-16 ${variantClasses}`}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <button
                type="button"
                onClick={save}
                className="h-6 w-6 flex items-center justify-center rounded text-success hover:bg-success/10 active:scale-95 transition-all"
                aria-label={t("apiKeyInput.save")}
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={cancel}
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
                <KeyRound className="w-3 h-3 text-muted-foreground/50 shrink-0" />
                {maskKey(apiKey)}
              </span>
            ) : (
              <span className="text-muted-foreground/40 text-xs">{resolvedPlaceholder}</span>
            )}
            <span className="ml-auto text-muted-foreground/30 text-xs group-hover:text-muted-foreground/60 transition-colors">
              {hasKey ? t("apiKeyInput.editButton") : t("apiKeyInput.addButton")}
            </span>
          </button>
        )}
      </div>

      {helpText && <p className="text-xs text-muted-foreground/70 mt-1">{helpText}</p>}
    </div>
  );
}
