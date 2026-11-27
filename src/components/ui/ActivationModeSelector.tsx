import { MousePointerClick, MicVocal } from "../icons";
import { useTranslation } from "react-i18next";

import type { DictationActivationMode } from "../../helpers/dictationActivationMode.mjs";
import { BIDI_VALUE_TOKEN, BidiInterpolatedText } from "./BidiInterpolatedText";

interface ActivationModeSelectorProps {
  value: DictationActivationMode;
  onChange: (mode: DictationActivationMode) => void;
  pushDisabledReason?: string;
  doubleTapHotkey?: string;
  doubleTapDisabledReason?: string;
  /** "onboarding" draws the control in the setup flow's pill grammar and tokens. */
  variant?: "default" | "onboarding";
}

const OPTIONS = [
  { mode: "tap", Icon: MousePointerClick, labelKey: "common.tap", offset: "translate-x-0" },
  {
    mode: "push",
    Icon: MicVocal,
    labelKey: "common.hold",
    offset: "translate-x-full rtl:-translate-x-full",
  },
  {
    mode: "push-double-tap",
    Icon: MicVocal,
    labelKey: "settingsPage.general.hotkey.holdWithDoubleTap",
    offset: "translate-x-[200%] rtl:-translate-x-[200%]",
  },
] as const;

const STYLES = {
  default: {
    track: "rounded-md border p-0.5 bg-surface-1 border-border-subtle",
    indicator: "rounded border bg-surface-raised border-border-subtle",
    button: "gap-1.5 rounded px-2 py-1.5 text-xs sm:px-3.5",
    icon: "size-3.5",
    selected: "text-foreground",
    unselected: "text-muted-foreground enabled:hover:text-foreground",
  },
  onboarding: {
    track: "rounded-full p-1 bg-[var(--onboarding-surface-tertiary)]",
    indicator: "rounded-full bg-[var(--onboarding-surface)] shadow-sm",
    button: "min-h-8 gap-1.5 rounded-full px-2 py-1 text-sm leading-tight sm:px-4",
    icon: "size-4",
    selected: "text-[var(--onboarding-text-primary)]",
    unselected:
      "text-[var(--onboarding-text-secondary)] enabled:hover:text-[var(--onboarding-text-primary)]",
  },
} as const;

export function ActivationModeSelector({
  value,
  onChange,
  pushDisabledReason,
  doubleTapHotkey,
  doubleTapDisabledReason,
  variant = "default",
}: ActivationModeSelectorProps) {
  const { t } = useTranslation();
  const styles = STYLES[variant];
  const options = doubleTapHotkey ? OPTIONS : OPTIONS.slice(0, 2);
  const displayedMode = !doubleTapHotkey && value === "push-double-tap" ? "push" : value;
  const selected = OPTIONS.find(({ mode }) => mode === displayedMode) ?? OPTIONS[0];
  const picker = (
    <div
      className={`relative grid ${doubleTapHotkey ? "grid-cols-3" : "grid-cols-2"} transition-colors duration-200 ${styles.track}`}
    >
      <div
        aria-hidden="true"
        className={`absolute inset-y-[var(--inset)] start-[var(--inset)] w-[calc((100%-2*var(--inset))/var(--columns))] transition-transform duration-200 ease-out ${styles.indicator} ${selected.offset}`}
        style={
          {
            "--inset": variant === "onboarding" ? "4px" : "2px",
            "--columns": options.length,
          } as React.CSSProperties
        }
      />

      {options.map(({ mode, Icon, labelKey }) => {
        const disabledReason =
          mode === "push-double-tap"
            ? (pushDisabledReason ?? doubleTapDisabledReason)
            : mode === "push"
              ? pushDisabledReason
              : undefined;
        const disabled = Boolean(disabledReason);
        const label = t(labelKey);

        return (
          <button
            key={mode}
            type="button"
            disabled={disabled}
            title={disabledReason}
            aria-label={disabledReason ? `${label}: ${disabledReason}` : undefined}
            aria-pressed={displayedMode === mode}
            onClick={() => onChange(mode)}
            className={`relative z-10 flex min-w-0 items-center justify-center font-medium transition-colors duration-150 ${styles.button} ${
              disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            } ${displayedMode === mode ? styles.selected : styles.unselected}`}
          >
            <Icon className={`${styles.icon} shrink-0`} />
            <span className="[overflow-wrap:anywhere]">{label}</span>
          </button>
        );
      })}
    </div>
  );

  if (!doubleTapHotkey) return picker;

  return (
    <div className="min-w-0 max-w-full">
      {picker}
      {!pushDisabledReason && (doubleTapDisabledReason || value === "push-double-tap") && (
        <p className="mt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {doubleTapDisabledReason ?? (
            <BidiInterpolatedText
              text={t("settingsPage.general.hotkey.doubleTapHint", { hotkey: BIDI_VALUE_TOKEN })}
              value={doubleTapHotkey}
            />
          )}
        </p>
      )}
    </div>
  );
}
