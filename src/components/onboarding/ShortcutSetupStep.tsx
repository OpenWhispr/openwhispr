import { useState } from "react";
import { AlertCircle, Check } from "lucide-react";
import { HotkeyInput } from "../ui/HotkeyInput";
import { formatHotkeyLabel } from "../../utils/hotkeys";

export function HotkeyChord({ value, compact = false }: { value: string; compact?: boolean }) {
  const parts = formatHotkeyLabel(value).split("+");
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2"
      aria-label={formatHotkeyLabel(value)}
    >
      {parts.map((part) => (
        <kbd
          key={part}
          className={`flex items-center justify-center rounded-xl border border-border bg-card font-medium text-foreground shadow-[var(--shadow-card)] ${
            compact ? "min-w-10 px-3 py-2 text-xs" : "min-w-20 px-6 py-5 text-sm"
          }`}
        >
          {part}
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
}: ShortcutSetupStepProps) {
  const [candidate, setCandidate] = useState(value);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleChange = (next: string) => {
    const validationError = validate?.(next) ?? null;
    if (validationError) {
      setError(validationError);
      setCandidate("");
      setConfirmed(false);
      return;
    }

    setError(null);
    if (candidate === next && !confirmed) {
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
    <div className="mx-auto mt-10 w-full max-w-2xl space-y-5">
      <div className="overflow-hidden rounded-3xl border border-dashed border-border bg-card p-8 text-center shadow-sm">
        <HotkeyInput
          value={candidate}
          onChange={handleChange}
          onClear={reset}
          variant="hero"
          validate={validate}
        />

        {!candidate && !error && (
          <div className="pointer-events-none mt-4 flex flex-col items-center gap-1">
            <span className="text-xs text-muted-foreground">{captureLabel}</span>
            <span className="text-xs font-medium text-foreground">
              {recommendedLabel}: {formatHotkeyLabel(recommended)}
            </span>
          </div>
        )}
      </div>

      {candidate && !error && (
        <div className="space-y-4 text-center" aria-live="polite">
          <p className="text-sm text-muted-foreground">
            {confirmed ? (
              <span className="inline-flex items-center gap-2 text-success">
                <Check className="size-4" />
                {formatHotkeyLabel(candidate)}
              </span>
            ) : (
              confirmLabel(formatHotkeyLabel(candidate))
            )}
          </p>
          <button type="button" onClick={reset} className="text-sm text-primary hover:underline">
            {chooseAnotherLabel}
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center justify-center gap-2 rounded-2xl border border-destructive/20 bg-destructive/8 px-4 py-5 text-sm text-destructive"
        >
          <AlertCircle className="size-4" />
          {error}
        </div>
      )}
    </div>
  );
}
