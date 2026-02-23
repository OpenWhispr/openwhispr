import React, { useState, useEffect, useRef, useCallback } from "react";
import { Check, X } from "lucide-react";
import { Input } from "./input";

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
  if (key.length <= 4) return "••••";
  return key.slice(0, 4) + "••••••••";
}

export default function ApiKeyInput({
  apiKey,
  setApiKey,
  className = "",
  placeholder = "Paste your API key",
  label = "API Key",
  ariaLabel,
  helpText,
  variant = "default",
}: ApiKeyInputProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  const setApiKeyRef = useRef(setApiKey);
  const hasKey = apiKey.length > 0;
  const variantClasses = variant === "purple" ? "border-primary focus:border-primary" : "";

  draftRef.current = draft;
  setApiKeyRef.current = setApiKey;

  const enterEdit = useCallback(() => {
    setDraft(apiKey);
    setIsEditing(true);
  }, [apiKey]);

  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [isEditing]);

  const save = useCallback(() => {
    const value = draftRef.current.trim();
    setApiKeyRef.current(value);
    setIsEditing(false);
  }, []);

  const cancel = useCallback(() => {
    setDraft("");
    setIsEditing(false);
  }, []);

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

  const handleBlur = (e: React.FocusEvent) => {
    if (containerRef.current?.contains(e.relatedTarget as Node)) return;
    cancel();
  };

  return (
    <div className={className}>
      {label && <label className="block text-xs font-medium text-foreground mb-1">{label}</label>}

      <div ref={containerRef} className="relative">
        {isEditing ? (
          <div className="relative">
            <Input
              ref={inputRef}
              type="text"
              placeholder={placeholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              aria-label={ariaLabel || label || "API Key"}
              className={`h-8 text-sm font-mono pr-16 ${variantClasses}`}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  save();
                }}
                className="h-6 w-6 flex items-center justify-center rounded text-success hover:bg-success/10 active:scale-95 transition-all"
                tabIndex={-1}
                aria-label="Save API key"
              >
                <Check className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  cancel();
                }}
                className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 active:scale-95 transition-all"
                tabIndex={-1}
                aria-label="Cancel editing"
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
            aria-label={hasKey ? "Edit API key" : "Add API key"}
          >
            {hasKey ? (
              <span className="flex items-center gap-1.5 text-foreground/70 font-mono text-xs tracking-wide">
                <Check className="w-3 h-3 text-success shrink-0" />
                {maskKey(apiKey)}
              </span>
            ) : (
              <span className="text-muted-foreground/40 text-xs">
                {placeholder}
              </span>
            )}
            <span className="ml-auto text-muted-foreground/30 text-xs group-hover:text-muted-foreground/60 transition-colors">
              {hasKey ? "edit" : "add"}
            </span>
          </button>
        )}
      </div>

      {helpText && <p className="text-xs text-muted-foreground/70 mt-1">{helpText}</p>}
    </div>
  );
}
