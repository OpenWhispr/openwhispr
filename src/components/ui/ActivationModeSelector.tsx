import { MousePointerClick, MicVocal, Pointer } from "lucide-react";
import { useTranslation } from "react-i18next";

// Mirrors ActivationMode in src/helpers/activationMode.js (kept inline so the
// node --test renderer harness can load this file without a type import).
type ActivationMode = "tap" | "push" | "hybrid";

interface ActivationModeSelectorProps {
  value: ActivationMode;
  onChange: (mode: ActivationMode) => void;
  pushDisabledReason?: string;
}

// Hybrid rides on the push-to-talk plumbing, so it is unavailable wherever Hold is.
const OPTIONS = [
  { mode: "tap", Icon: MousePointerClick, labelKey: "common.tap", needsPush: false },
  { mode: "push", Icon: MicVocal, labelKey: "common.hold", needsPush: true },
  { mode: "hybrid", Icon: Pointer, labelKey: "common.hybrid", needsPush: true },
] as const;

const INDICATOR_OFFSET: Record<ActivationMode, string> = {
  tap: "translate-x-0",
  push: "translate-x-[calc(100%+2px)]",
  hybrid: "translate-x-[calc(200%+4px)]",
};

export function ActivationModeSelector({
  value,
  onChange,
  pushDisabledReason,
}: ActivationModeSelectorProps) {
  const { t } = useTranslation();

  return (
    <div className="relative flex rounded-md border p-0.5 transition-colors duration-200 bg-surface-1 border-border-subtle">
      {/* Sliding indicator */}
      <div
        className={`
          absolute top-0.5 bottom-0.5 w-[calc(33.333%-2px)] rounded
          bg-surface-raised border border-border-subtle
          transition-transform duration-200 ease-out
          ${INDICATOR_OFFSET[value] ?? INDICATOR_OFFSET.tap}
        `}
      />

      {OPTIONS.map(({ mode, Icon, labelKey, needsPush }) => {
        const disabledReason = needsPush ? pushDisabledReason : undefined;
        const disabled = Boolean(disabledReason);
        const label = t(labelKey);

        return (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            title={disabledReason}
            aria-label={disabledReason ? `${label}: ${disabledReason}` : undefined}
            onClick={() => onChange(mode)}
            className={`
              relative z-10 flex-1 flex items-center justify-center gap-1 rounded px-2.5 py-1
              transition-colors duration-150
              ${disabled ? "cursor-not-allowed" : "cursor-pointer"}
              ${value === mode ? "text-foreground" : "text-muted-foreground hover:text-foreground"}
            `}
          >
            <Icon className="w-3 h-3" />
            <span className="text-xs font-medium">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
