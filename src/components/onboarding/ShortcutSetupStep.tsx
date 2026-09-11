import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Loader2 } from "../icons";
import { HotkeyInput } from "../ui/HotkeyInput";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import {
  formatHotkeyInstruction,
  formatRecommendedHotkey,
  getHotkeyKeycaps,
} from "./hotkeyPresentation";

function HotkeyChord({ value, compact = false }: { value: string; compact?: boolean }) {
  const keycaps = getHotkeyKeycaps(value);

  return (
    <div
      dir="ltr"
      className={`flex flex-wrap items-center justify-center ${compact ? "gap-1.5" : "gap-3"}`}
      aria-label={formatHotkeyLabel(value)}
    >
      {keycaps.map(({ id, icon, label, symbol }) => (
        <kbd
          key={id}
          // Surface, bevel and border live in .onboarding-keycap so the cap is
          // styled in one place; only the box metrics vary by size here.
          className={`onboarding-keycap relative flex flex-col justify-between rounded-xl border text-[var(--onboarding-text-primary)] ${
            compact ? "h-12 min-w-16 px-2.5 py-2 text-xs" : "h-24 min-w-32 px-3 py-3 text-base"
          }`}
        >
          <span
            className={`self-end font-medium leading-none ${compact ? "text-base" : "text-xl"}`}
            aria-hidden="true"
          >
            {icon === "globe" ? (
              <Globe
                className={compact ? "size-4" : "size-5"}
                strokeWidth={1.8}
                aria-hidden="true"
              />
            ) : (
              symbol
            )}
          </span>
          <span className="self-start font-medium leading-none text-[var(--onboarding-text-secondary)]">
            {label}
          </span>
        </kbd>
      ))}
    </div>
  );
}

interface ShortcutSetupStepProps {
  value: string;
  initiallyConfirmed?: boolean;
  onChange: (value: string) => void;
  recommended: string | string[];
  captureLabel: string;
  recommendedLabel: string;
  chooseAnotherLabel: string;
  validate?: (value: string) => string | null;
  onConfirm?: (value: string) => Promise<string | null>;
  /** Fires whenever the capture box goes back to empty, so the caller can drop
      whatever it recorded from a previous `onChange`. */
  onClearSelection?: () => void;
  dense?: boolean;
}

/**
 * Opens empty and listening: the first thing the user does is press the key they
 * want, and the recommendations sit right under the box as one-click picks.
 * Either way the key is registered on the spot; "Choose another shortcut" is the
 * way out.
 */
export default function ShortcutSetupStep({
  value,
  initiallyConfirmed,
  onChange,
  recommended,
  captureLabel,
  recommendedLabel,
  chooseAnotherLabel,
  validate,
  onConfirm,
  onClearSelection,
  dense = false,
}: ShortcutSetupStepProps) {
  const { t } = useTranslation();
  const recommendations = Array.isArray(recommended) ? recommended : [recommended];
  // Only a chord the user already confirmed reopens in the box; a resumed step
  // must not ask for it again.
  const [candidate, setCandidate] = useState(initiallyConfirmed ? value : "");
  const [confirmed, setConfirmed] = useState(Boolean(initiallyConfirmed && value));
  const [error, setError] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [captureKey, setCaptureKey] = useState(0);
  // The capture box hides the input behind its own surface, so the keys being
  // held have to be echoed here or pressing a bare modifier looks like nothing.
  const [heldModifiers, setHeldModifiers] = useState("");

  const clear = () => {
    setCandidate("");
    setConfirmed(false);
    // HotkeyInput blurs after every completed capture. Remounting restores focus
    // so the box is listening again straight away.
    setCaptureKey((current) => current + 1);
    onClearSelection?.();
  };

  const confirm = async (next: string) => {
    setError(null);
    setCandidate(next);
    setIsConfirming(true);
    const confirmationError = (await onConfirm?.(next)) ?? null;
    setIsConfirming(false);
    if (confirmationError) {
      setError(confirmationError);
      clear();
      return;
    }
    setConfirmed(true);
    onChange(next);
  };

  const handleCapture = (next: string) => {
    if (confirmed && candidate === next) return;
    void confirm(next);
  };

  const captureInput = (
    <HotkeyInput
      key={captureKey}
      value={candidate}
      onChange={handleCapture}
      onClear={clear}
      autoFocus
      variant="capture-overlay"
      validate={validate}
      onValidationError={setError}
      onHeldModifiersChange={setHeldModifiers}
      disabled={isConfirming}
    />
  );

  const errorMessage = error && (
    <p role="alert" className="max-w-72 text-sm leading-5 text-[var(--onboarding-danger)]">
      {error}
    </p>
  );

  return (
    <div
      className={`mx-auto mt-6 flex w-full flex-col items-center text-center ${dense ? "max-w-sm" : "max-w-lg"}`}
    >
      {candidate ? (
        <div
          className={`relative flex w-full items-center justify-center ${dense ? "h-12" : "h-40"}`}
        >
          {captureInput}
          {errorMessage ||
            (isConfirming ? (
              <Loader2 className="size-5 animate-spin text-[var(--onboarding-accent)]" />
            ) : (
              <HotkeyChord value={heldModifiers || candidate} compact={dense} />
            ))}
        </div>
      ) : (
        <div className="relative flex h-44 w-full items-center justify-center rounded-3xl border-2 border-dashed border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-5">
          {captureInput}
          {errorMessage ||
            (heldModifiers ? (
              <div className="pointer-events-none flex flex-col items-center gap-3">
                <HotkeyChord value={heldModifiers} compact />
                <p className="text-sm leading-[1.4] text-[var(--onboarding-text-tertiary)]">
                  {t("onboarding.rehaul.hotkey.holding")}
                </p>
              </div>
            ) : (
              <div className="pointer-events-none flex flex-col items-center gap-4">
                <Loader2 className="size-5 animate-spin text-[var(--onboarding-accent)]" />
                <p className="text-base leading-[1.4] text-[var(--onboarding-text-tertiary)]">
                  {captureLabel}
                </p>
              </div>
            ))}
        </div>
      )}

      {/* One row under the box carries whatever comes next: the picks while it is
          empty, the way out once a key is in it. */}
      <div
        className={`flex flex-wrap items-center justify-center leading-[1.4] text-[var(--onboarding-text-tertiary)] ${
          dense ? "mt-3 gap-2 text-sm" : "mt-6 gap-3 text-base"
        }`}
        aria-live="polite"
      >
        {candidate ? (
          <>
            <p className="sr-only">{formatHotkeyInstruction(candidate)}</p>
            <button
              type="button"
              onClick={clear}
              disabled={isConfirming}
              className="onboarding-pressable rounded-full border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-1.5 text-sm text-[var(--onboarding-text-primary)] hover:bg-[var(--onboarding-surface-hover)] disabled:cursor-default disabled:opacity-60"
            >
              {chooseAnotherLabel}
            </button>
          </>
        ) : (
          <>
            <span>{recommendedLabel}</span>
            {recommendations.map((hotkey) => (
              <button
                key={hotkey}
                type="button"
                onClick={() => void confirm(hotkey)}
                disabled={isConfirming}
                className={`onboarding-pressable rounded-full bg-[var(--onboarding-surface-tertiary)] text-[var(--onboarding-text-secondary)] hover:bg-[var(--onboarding-surface-tertiary-hover)] hover:text-[var(--onboarding-text-primary)] disabled:cursor-default ${
                  dense ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm"
                }`}
              >
                {formatRecommendedHotkey(hotkey)}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
