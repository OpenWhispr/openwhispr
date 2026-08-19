import { useState } from "react";
import { useTranslation } from "react-i18next";
import { HotkeyInput } from "../ui/HotkeyInput";
import { formatHotkeyLabel } from "../../utils/hotkeys";
import { formatHotkeyInstruction, getHotkeyKeycaps } from "./hotkeyPresentation";

function HotkeyChord({ value, compact = false }: { value: string; compact?: boolean }) {
  const keycaps = getHotkeyKeycaps(value);

  return (
    <div
      className={`flex flex-wrap items-center justify-center ${compact ? "gap-1.5" : "gap-3"}`}
      aria-label={formatHotkeyLabel(value)}
    >
      {keycaps.map(({ id, label, symbol }) => (
        <kbd
          key={id}
          // Surface, bevel and border live in .onboarding-keycap so the cap is
          // styled in one place; only the box metrics vary by size here.
          className={`onboarding-keycap relative flex flex-col justify-between rounded-[12px] border text-[var(--onboarding-text-primary)] ${
            compact ? "h-8 min-w-12 px-2 py-1 text-xs" : "h-16 min-w-20 px-2.5 py-2 text-xs"
          }`}
        >
          <span
            className={`self-end font-medium leading-none ${compact ? "text-sm" : "text-lg"}`}
            aria-hidden="true"
          >
            {symbol}
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

  const handleChange = async (next: string) => {
    setError(null);
    setCandidate(next);
    setConfirmed(false);
    setIsConfirming(true);
    const confirmationError = (await onConfirm?.(next)) ?? null;
    setIsConfirming(false);
    if (confirmationError) {
      setError(confirmationError);
      setCandidate("");
      setCaptureKey((current) => current + 1);
      // A failed capture leaves the box empty, so an earlier confirmed hotkey
      // must not keep the step looking complete.
      onClearSelection?.();
      return;
    }
    setConfirmed(true);
    onChange(next);
  };

  const reset = () => {
    setCandidate("");
    setConfirmed(false);
    setError(null);
    setCaptureKey((current) => current + 1);
    onClearSelection?.();
  };

  return (
    // The assistant page keeps the tighter margin because it also includes the
    // preview image; the standalone shortcut page has a little more separation.
    <div className={`mx-auto w-full max-w-sm shrink-0 text-center ${dense ? "mt-4" : "mt-5"}`}>
      {/* Compact capture surface. The filled state drops the dash and tint so
          the keycaps sit on their own surface. */}
      <div
        className={`relative flex h-32 items-center justify-center rounded-2xl px-5 ${
          candidate
            ? "border-2 border-transparent bg-[var(--onboarding-surface)]"
            : "border-2 border-dashed border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface-secondary)]"
        }`}
      >
        <HotkeyInput
          key={captureKey}
          value={candidate}
          onChange={(next) => void handleChange(next)}
          onClear={reset}
          autoFocus
          variant="capture-overlay"
          validate={validate}
          onValidationError={setError}
          onHeldModifiersChange={setHeldModifiers}
          disabled={isConfirming}
        />

        {error ? (
          <p role="alert" className="max-w-60 text-sm leading-5 text-[var(--onboarding-danger)]">
            {error}
          </p>
        ) : heldModifiers ? (
          <div className="pointer-events-none flex flex-col items-center gap-3">
            <HotkeyChord value={heldModifiers} />
            <p className="text-sm leading-[1.4] text-[var(--onboarding-text-tertiary)]">
              {t("onboarding.rehaul.hotkey.holding")}
            </p>
          </div>
        ) : candidate ? (
          <HotkeyChord value={candidate} />
        ) : (
          // The recommendation leads and the capture instruction closes; the
          // pair remains centred as the surface scales down.
          <div className="pointer-events-none flex flex-col items-center gap-8">
            <p className="flex items-center gap-2 text-base leading-[1.4] text-[var(--onboarding-text-tertiary)]">
              {recommendedLabel}
              <span className="rounded-[39px] bg-[var(--onboarding-surface-tertiary)] px-2.5 py-1.5 text-xs leading-[1.4] text-[var(--onboarding-text-secondary)]">
                {formatHotkeyInstruction(recommended)}
              </span>
            </p>
            <p className="text-base leading-[1.4] text-[var(--onboarding-text-tertiary)]">
              {captureLabel}
            </p>
          </div>
        )}
      </div>

      {candidate && confirmed && !error && showCandidateActions && (
        <div className="mt-5 text-center" aria-live="polite">
          {/* The keycaps above are the visual confirmation, so the pill that used
              to sit here is sr-only rather than deleted: HotkeyChord's aria-label
              is not a live region, so this is the only spoken confirmation that
              the chord was accepted. */}
          <p className="sr-only">{formatHotkeyInstruction(candidate)}</p>
          <button
            type="button"
            onClick={reset}
            className="rounded-full border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-4 py-1.5 text-sm text-[var(--onboarding-text-primary)] hover:bg-[var(--onboarding-surface-hover)]"
          >
            {chooseAnotherLabel}
          </button>
        </div>
      )}
    </div>
  );
}
