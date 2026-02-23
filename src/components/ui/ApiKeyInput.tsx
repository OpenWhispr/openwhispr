import React from "react";
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

export default function ApiKeyInput({
  apiKey,
  setApiKey,
  className = "",
  placeholder = "sk-...",
  label = "API Key",
  ariaLabel,
  helpText = "Get your API key from platform.openai.com",
  variant = "default",
}: ApiKeyInputProps) {
  const hasKey = apiKey.length > 0;
  const variantClasses = variant === "purple" ? "border-primary focus:border-primary" : "";

  return (
    <div className={className}>
      {label && <label className="block text-xs font-medium text-foreground mb-1">{label}</label>}
      <div className="relative">
        <Input
          type="password"
          placeholder={placeholder}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          aria-label={ariaLabel || label || "API Key"}
          className={`h-8 text-sm ${hasKey ? "pr-14" : ""} ${variantClasses}`}
        />
        {hasKey && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <Check className="w-3 h-3 text-success shrink-0" />
            <button
              type="button"
              onClick={() => setApiKey("")}
              className="w-4 h-4 flex items-center justify-center rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
              tabIndex={-1}
              aria-label="Clear API key"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>
      {helpText && <p className="text-xs text-muted-foreground/70 mt-1">{helpText}</p>}
    </div>
  );
}
