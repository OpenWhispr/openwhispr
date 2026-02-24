import { MessageSquareText, Bot } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { DictationMode } from "../../types/hotkeyBindings";

interface DictationModeSelectorProps {
  value: DictationMode;
  onChange: (mode: DictationMode) => void;
  disabled?: boolean;
  variant?: "default" | "compact";
}

export function DictationModeSelector({
  value,
  onChange,
  disabled = false,
  variant = "default",
}: DictationModeSelectorProps) {
  const { t } = useTranslation();
  const isCompact = variant === "compact";

  return (
    <div
      className={`
        relative flex rounded-md border transition-colors duration-200
        bg-surface-1 border-border-subtle p-0.5
        ${disabled ? "opacity-50 cursor-not-allowed" : ""}
      `}
    >
      <div
        className={`
          absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded
          bg-surface-raised border border-border-subtle
          transition-transform duration-200 ease-out
          ${value === "agent" ? "translate-x-[calc(100%+4px)]" : "translate-x-0"}
        `}
      />

      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("transcription")}
        className={`
          relative z-10 flex-1 flex items-center justify-center gap-1.5 rounded
          transition-colors duration-150
          ${isCompact ? "px-2.5 py-1.5" : "px-3 py-2"}
          ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
          ${value === "transcription" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
        `}
      >
        <MessageSquareText className={isCompact ? "w-3.5 h-3.5" : "w-4 h-4"} />
        <span className={`font-medium ${isCompact ? "text-xs" : "text-sm"}`}>
          {t("common.dictation")}
        </span>
      </button>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("agent")}
        className={`
          relative z-10 flex-1 flex items-center justify-center gap-1.5 rounded
          transition-colors duration-150
          ${isCompact ? "px-2.5 py-1.5" : "px-3 py-2"}
          ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
          ${value === "agent" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
        `}
      >
        <Bot className={isCompact ? "w-3.5 h-3.5" : "w-4 h-4"} />
        <span className={`font-medium ${isCompact ? "text-xs" : "text-sm"}`}>
          {t("common.agent")}
        </span>
      </button>
    </div>
  );
}
