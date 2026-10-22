import type { ReactNode } from "react";
import { Check } from "../icons";
import { cn } from "../lib/utils";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The option's label, which the whole row toggles. */
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** A labelled checkbox row: a button, so Space and a click both toggle it. */
export function Checkbox({
  checked,
  onChange,
  children,
  disabled = false,
  className,
}: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-center gap-3 rounded-md py-1.5 text-start text-[14px] text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 agent:min-h-10 agent:gap-3.5 agent:px-1.5 agent:py-2 agent:text-[15px] agent:font-medium",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-foreground/20 bg-transparent"
        )}
      >
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      <span dir="auto" className="min-w-0 flex-1">
        {children}
      </span>
    </button>
  );
}
