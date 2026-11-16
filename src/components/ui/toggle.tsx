import React from "react";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export const Toggle = ({ checked, onChange, disabled = false, ariaLabel }: ToggleProps) => {
  const getTrackClasses = () => {
    if (disabled) {
      return checked ? "bg-brand-solid/40" : "bg-surface-secondary";
    }
    return checked
      ? "bg-brand-solid hover:bg-brand-solid/90"
      : "bg-text-secondary/30 hover:bg-text-secondary/40 dark:bg-surface-tertiary dark:hover:bg-surface-tertiary";
  };

  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-focus/40 focus-visible:ring-offset-1 ${getTrackClasses()} ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full transition-transform duration-150 ${
          checked ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1"
        } ${disabled ? "bg-text-secondary/50" : "bg-surface-primary shadow-sm"}`}
      />
    </button>
  );
};
