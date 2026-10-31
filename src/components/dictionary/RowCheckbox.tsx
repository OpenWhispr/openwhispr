import type { MouseEvent, ReactElement, ReactNode } from "react";
import { cn } from "../lib/utils";

interface RowCheckboxProps {
  checked: boolean;
  // The click event carries shiftKey, which a list uses to tick a range.
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  // The accessible name when the checkbox has no visible label of its own.
  label?: string;
  disabled?: boolean;
  className?: string;
  // A visible label makes the whole row the checkbox, as in the share popover's list rows.
  children?: ReactNode;
}

function CheckboxBox({ checked }: { checked: boolean }): ReactElement {
  if (checked) {
    return (
      <svg className="size-3.5 shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect width="16" height="16" rx="4" className="fill-primary" />
        <path
          d="M12 5L6.5 10.5L4 8"
          stroke="white"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <span
      className="size-3.5 shrink-0 rounded-[4px] border border-foreground/30 dark:border-white/35"
      aria-hidden="true"
    />
  );
}

// A native button, so Space and Enter toggle it without extra key handling.
export function RowCheckbox({
  checked,
  onToggle,
  label,
  disabled = false,
  className,
  children,
}: RowCheckboxProps): ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={children ? undefined : label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "flex items-center rounded-[5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-default",
        className
      )}
    >
      <CheckboxBox checked={checked} />
      {children}
    </button>
  );
}
