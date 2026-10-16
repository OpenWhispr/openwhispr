import { MousePointerClick, MicVocal } from "../icons";
import { useTranslation } from "react-i18next";

type ActivationMode = "tap" | "push";

interface ActivationModeSelectorProps {
  value: ActivationMode;
  onChange: (mode: ActivationMode) => void;
  pushDisabledReason?: string;
}

const OPTIONS = [
  { mode: "tap", Icon: MousePointerClick, labelKey: "common.tap" },
  { mode: "push", Icon: MicVocal, labelKey: "common.hold" },
] as const;

export function ActivationModeSelector({
  value,
  onChange,
  pushDisabledReason,
}: ActivationModeSelectorProps) {
  const { t } = useTranslation();

  return (
    // Two equal columns, so the half-width indicator covers exactly one option
    // and a single full-width translate lands it under the other.
    <div className="relative grid grid-cols-2 rounded-md border p-0.5 bg-surface-1 border-border-subtle transition-colors duration-200">
      <div
        className={`absolute inset-y-0.5 start-0.5 w-[calc(50%-2px)] rounded border bg-surface-raised border-border-subtle transition-transform duration-200 ease-out ${
          value === "push" ? "translate-x-full rtl:-translate-x-full" : "translate-x-0"
        }`}
      />

      {OPTIONS.map(({ mode, Icon, labelKey }) => {
        const disabledReason = mode === "push" ? pushDisabledReason : undefined;
        const disabled = Boolean(disabledReason);
        const label = t(labelKey);

        return (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            title={disabledReason}
            aria-label={disabledReason ? `${label}: ${disabledReason}` : undefined}
            aria-pressed={value === mode}
            onClick={() => onChange(mode)}
            className={`relative z-10 flex items-center justify-center gap-1.5 rounded px-3.5 py-1.5 text-xs font-medium transition-colors duration-150 ${
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            } ${value === mode ? "text-foreground" : "text-muted-foreground enabled:hover:text-foreground"}`}
          >
            <Icon className="size-3.5" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
