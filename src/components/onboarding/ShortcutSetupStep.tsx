import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Loader2 } from "lucide-react";
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
  onChange: (value: string) => void;
  recommended: string;
  captureLabel: string;
  recommendedLabel: string;
  chooseAnotherLabel: string;
  validate?: (value: string) => string | null;
  onConfirm?: (value: string) => Promise<string | null>;
  /** Fires whenever the capture box goes back to empty, so the caller can drop
      whatever it recorded from a previous `onChange`. */
  onClearSelection?: () => void;
  dense?: boolean;
  showCandidateActions?: boolean;
}

export default function ShortcutSetupStep({
  value,
  onChange,
  recommended,
  captureLabel,
  recommendedLabel,
  chooseAnotherLabel,
  validate,
  onConfirm,
  onClearSelection,
  dense = false,
  showCandidateActions = true,
}: ShortcutSetupStepProps) {
  const { t } = useTranslation();
  const [candidate, setCandidate] = useState(value);
  const [confirmed, setConfirmed] = useState(Boolean(value));
  const [error, setError] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [captureKey, setCaptureKey] = useState(0);
  // The capture box hides the input behind its own surface, so the keys being
  // held have to be echoed here or pressing a bare modifier looks like nothing.
  const [heldModifiers, setHeldModifiers] = useState("");

  const handleCapture = async (next: string) => {
    setError(null);
    if (!confirmed && candidate === next) {
      setIsConfirming(true);
      const confirmationError = (await onConfirm?.(next)) ?? null;
      setIsConfirming(false);
      if (confirmationError) {
        setError(confirmationError);
        setCandidate("");
        setCaptureKey((current) => current + 1);
        onClearSelection?.();
        return;
      }
      setConfirmed(true);
      onChange(next);
      return;
    }

    setCandidate(next);
    setConfirmed(false);
    onClearSelection?.();
    // HotkeyInput blurs after every completed capture. Remounting restores focus
    // so the candidate can be confirmed immediately with the same chord.
    setCaptureKey((current) => current + 1);
  };

  const reset = () => {
    setCandidate("");
    setConfirmed(false);
    setError(null);
    setCaptureKey((current) => current + 1);
    onClearSelection?.();
  };

  const captureInput = (
    <HotkeyInput
      key={captureKey}
      value={candidate}
      onChange={(next) => void handleCapture(next)}
      onClear={reset}
      autoFocus
      variant="capture-overlay"
      validate={validate}
      onValidationError={setError}
      onHeldModifiersChange={setHeldModifiers}
      disabled={isConfirming}
    />
  );

  return (
    <div
      className={`mx-auto flex min-h-0 w-full flex-1 flex-col text-center ${
        dense ? "mt-4 max-w-sm" : "mt-6 max-w-lg"
      }`}
    >
      {candidate ? (
        <>
          <div className={`relative flex items-center justify-center ${dense ? "h-28" : "h-40"}`}>
            {captureInput}
            {error ? (
              <p
                role="alert"
                className="max-w-72 text-sm leading-5 text-[var(--onboarding-danger)]"
              >
                {error}
              </p>
            ) : isConfirming ? (
              <Loader2 className="size-5 animate-spin text-[var(--onboarding-accent)]" />
            ) : (
              <HotkeyChord value={heldModifiers || candidate} compact={dense} />
            )}
          </div>

          <div className="mt-auto flex flex-col items-center gap-2.5 pb-1" aria-live="polite">
            {confirmed ? (
              <p className="sr-only">{formatHotkeyInstruction(candidate)}</p>
            ) : (
              <p className="rounded-full bg-[var(--onboarding-surface-tertiary)] px-5 py-2 text-sm text-[var(--onboarding-text-tertiary)]">
                {t("onboarding.rehaul.hotkey.confirmAgain", {
                  hotkey: formatHotkeyInstruction(candidate),
                })}
              </p>
            )}
            {showCandidateActions && (
              <button
                type="button"
                onClick={reset}
                className="rounded-full border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-5 py-2 text-sm text-[var(--onboarding-text-primary)] hover:bg-[var(--onboarding-surface-hover)]"
              >
                {chooseAnotherLabel}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="relative flex h-44 items-center justify-center rounded-3xl border-2 border-dashed border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-5">
            {captureInput}
            {error ? (
              <p
                role="alert"
                className="max-w-72 text-sm leading-5 text-[var(--onboarding-danger)]"
              >
                {error}
              </p>
            ) : heldModifiers ? (
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
            )}
          </div>

          <p className="mt-6 flex items-center justify-center gap-3 text-base leading-[1.4] text-[var(--onboarding-text-tertiary)]">
            {recommendedLabel}
            <span className="rounded-full bg-[var(--onboarding-surface-tertiary)] px-3 py-1.5 text-sm text-[var(--onboarding-text-secondary)]">
              {formatRecommendedHotkey(recommended)}
            </span>
          </p>
        </>
      )}
    </div>
  );
}
