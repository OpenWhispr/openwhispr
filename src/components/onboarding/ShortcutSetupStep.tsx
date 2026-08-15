import { useState } from "react";
import { HotkeyInput } from "../ui/HotkeyInput";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { formatHotkeyInstruction, getHotkeyKeycaps } from "./hotkeyPresentation";

export function HotkeyChord({ value, compact = false }: { value: string; compact?: boolean }) {
  const keycaps = getHotkeyKeycaps(value);

  return (
    <div
      className={`flex flex-wrap items-center justify-center ${compact ? "gap-1.5" : "gap-5"}`}
      aria-label={formatHotkeyLabel(value)}
    >
      {keycaps.map(({ id, label, symbol }) => (
        <kbd
          key={id}
          className={`onboarding-keycap relative flex flex-col justify-between rounded-lg border border-neutral-300 bg-neutral-200 text-neutral-950 ${
            compact ? "h-8 min-w-12 px-2 py-1 text-xs" : "h-20 w-26 px-2.5 py-2 text-sm"
          }`}
        >
          <span className="self-end text-base font-semibold leading-none">{symbol}</span>
          <span className="self-start font-medium leading-none">{label}</span>
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
  confirmLabel: (label: string) => string;
  chooseAnotherLabel: string;
  validate?: (value: string) => string | null;
  onConfirm?: (value: string) => Promise<string | null>;
  dense?: boolean;
  showCandidateActions?: boolean;
}

export default function ShortcutSetupStep({
  value,
  onChange,
  recommended,
  captureLabel,
  recommendedLabel,
  confirmLabel,
  chooseAnotherLabel,
  validate,
  onConfirm,
  dense = false,
  showCandidateActions = true,
}: ShortcutSetupStepProps) {
  const [candidate, setCandidate] = useState(value);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);

  const handleChange = async (next: string) => {
    setError(null);
    if (candidate === next && !confirmed) {
      setIsConfirming(true);
      const confirmationError = (await onConfirm?.(next)) ?? null;
      setIsConfirming(false);
      if (confirmationError) {
        setError(confirmationError);
        setCandidate("");
        return;
      }
      setConfirmed(true);
      onChange(next);
      return;
    }
    setCandidate(next);
    setConfirmed(false);
  };

  const reset = () => {
    setCandidate("");
    setConfirmed(false);
    setError(null);
  };

  return (
    <div className={`mx-auto w-full max-w-[22.25rem] text-center ${dense ? "mt-4" : "mt-8"}`}>
      <div
        className={`relative flex h-32 items-center justify-center rounded-2xl bg-white px-6 ${
          candidate ? "border border-transparent" : "border border-dashed border-neutral-300"
        }`}
      >
        <HotkeyInput
          value={candidate}
          onChange={(next) => void handleChange(next)}
          onClear={reset}
          variant="capture-overlay"
          validate={validate}
          onValidationError={setError}
          disabled={isConfirming}
        />

        {error ? (
          <p role="alert" className="max-w-60 text-sm leading-5 text-red-500">
            {error}
          </p>
        ) : candidate ? (
          <HotkeyChord value={candidate} />
        ) : (
          <div className="pointer-events-none flex flex-col items-center">
            <p className="text-base text-neutral-400">{captureLabel}</p>
            <p className="mt-10 flex items-center gap-2 text-sm text-neutral-400">
              {recommendedLabel}
              <span className="rounded-full bg-neutral-200 px-2.5 py-1 text-xs text-neutral-600">
                {formatHotkeyInstruction(recommended)}
              </span>
            </p>
          </div>
        )}
      </div>

      {candidate && !error && showCandidateActions && (
        <div className="mt-8 space-y-2 text-center" aria-live="polite">
          <p className="mx-auto w-fit rounded-full bg-neutral-200 px-5 py-2 text-sm text-neutral-600">
            {confirmed
              ? formatHotkeyInstruction(candidate)
              : confirmLabel(formatHotkeyInstruction(candidate))}
          </p>
          <button
            type="button"
            onClick={reset}
            className="rounded-full border border-neutral-200 bg-white px-5 py-2 text-sm text-neutral-950 hover:bg-neutral-50"
          >
            {chooseAnotherLabel}
          </button>
        </div>
      )}
    </div>
  );
}
