import { MousePointerClick, MicVocal } from "lucide-react";
import { useTranslation } from "react-i18next";

type ActivationMode = "tap" | "push";

interface ActivationModeSelectorProps {
  value: ActivationMode;
  onChange: (mode: ActivationMode) => void;
  disabled?: boolean;
  /** Compact variant for inline use */
  variant?: "default" | "compact";
}

export function ActivationModeSelector({
  value,
  onChange,
  disabled = false,
  variant = "default",
}: ActivationModeSelectorProps) {
  const { t } = useTranslation();
  const isCompact = variant === "compact";

  return (
    <div
      className={`
        relative flex rounded-md border transition-colors duration-200
        bg-surface-1 border-border-subtle
        ${isCompact ? "p-0.5" : "p-0.5"}
        ${disabled ? "opacity-50 cursor-not-allowed" : ""}
      `}
    >
      {/* Sliding indicator */}
      <div
        className={`
          absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded
          bg-surface-raised border border-border-subtle
          transition-transform duration-200 ease-out
          ${value === "push" ? "translate-x-[calc(100%+4px)]" : "translate-x-0"}
        `}
      />

      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("tap")}
        className={`
          relative z-10 flex-1 flex items-center justify-center gap-1.5 rounded
          transition-colors duration-150
          ${isCompact ? "px-2.5 py-1.5" : "px-3 py-2"}
          ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
          ${value === "tap" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
        `}
      >
        <MousePointerClick className={isCompact ? "w-3.5 h-3.5" : "w-4 h-4"} />
        <span className={`font-medium ${isCompact ? "text-xs" : "text-sm"}`}>
          {t("common.tap")}
        </span>
      </button>

      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange("push")}
        className={`
          relative z-10 flex-1 flex items-center justify-center gap-1.5 rounded
          transition-colors duration-150
          ${isCompact ? "px-2.5 py-1.5" : "px-3 py-2"}
          ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
          ${value === "push" ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
        `}
      >
        <MicVocal className={isCompact ? "w-3.5 h-3.5" : "w-4 h-4"} />
        <span className={`font-medium ${isCompact ? "text-xs" : "text-sm"}`}>
          {t("common.hold")}
        </span>
      </button>
    </div>
  );
}
