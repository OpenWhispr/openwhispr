import { MousePointerClick, MicVocal } from "../icons";
import { useTranslation } from "react-i18next";

type ActivationMode = "tap" | "push";

interface ActivationModeSelectorProps {
  value: ActivationMode;
  onChange: (mode: ActivationMode) => void;
  pushDisabledReason?: string;
  /** "onboarding" draws the control in the setup flow's pill grammar and tokens. */
  variant?: "default" | "onboarding";
}

const OPTIONS = [
  { mode: "tap", Icon: MousePointerClick, labelKey: "common.tap" },
  { mode: "push", Icon: MicVocal, labelKey: "common.hold" },
] as const;

const STYLES = {
  default: {
    track: "rounded-md border p-0.5 bg-surface-1 border-border-subtle",
    indicator: "rounded border bg-surface-raised border-border-subtle",
    button: "gap-1.5 rounded px-3.5 py-1.5 text-xs",
    icon: "size-3.5",
    selected: "text-foreground",
    unselected: "text-muted-foreground hover:text-foreground",
  },
  onboarding: {
    track: "rounded-full p-1 bg-[var(--onboarding-surface-tertiary)]",
    indicator: "rounded-full bg-[var(--onboarding-surface)] shadow-sm",
    button: "h-8 gap-1.5 rounded-full px-4 text-sm",
    icon: "size-4",
    selected: "text-[var(--onboarding-text-primary)]",
    unselected:
      "text-[var(--onboarding-text-secondary)] hover:text-[var(--onboarding-text-primary)]",
  },
} as const;

export function ActivationModeSelector({
  value,
  onChange,
  pushDisabledReason,
  variant = "default",
}: ActivationModeSelectorProps) {
  const { t } = useTranslation();
  const styles = STYLES[variant];

  return (
    <div className={`relative flex transition-colors duration-200 ${styles.track}`}>
      {/* Sliding indicator: the track's padding is the inset on every side. */}
      <div
        className={`absolute inset-y-[var(--inset)] w-[calc(50%-var(--inset))] transition-transform duration-200 ease-out ${styles.indicator} ${
          value === "push"
            ? "translate-x-[calc(100%+var(--inset)*2)] rtl:-translate-x-[calc(100%+var(--inset)*2)]"
            : "translate-x-0"
        }`}
        style={{ "--inset": variant === "onboarding" ? "4px" : "2px" } as React.CSSProperties}
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
            className={`relative z-10 flex flex-1 items-center justify-center font-medium transition-colors duration-150 ${styles.button} ${
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            } ${value === mode ? styles.selected : styles.unselected}`}
          >
            <Icon className={styles.icon} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
