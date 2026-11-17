import * as React from "react";

import { cn } from "../lib/utils";

/** The text field's look, for a field Input doesn't render, such as a textarea. */
const INPUT_CLASS = cn(
  "flex h-10 w-full min-w-0 rounded border border-default/70 bg-surface-primary px-3 py-2 text-sm text-primary shadow-none transition-colors duration-200 outline-none",
  "placeholder:text-secondary/70",
  "selection:bg-brand-solid selection:text-on-solid",
  "file:text-primary file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-surface-secondary",
  "dark:bg-surface-secondary dark:border-default/60",
  "hover:border-hover",
  "focus-visible:border-brand-solid focus-visible:ring-2 focus-visible:ring-brand-solid/10",
  "dark:focus-visible:border-focus dark:focus-visible:ring-focus/10",
  "aria-invalid:ring-red-solid/20 dark:aria-invalid:ring-red-solid/40 aria-invalid:border-red-solid"
);

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(INPUT_CLASS, className)} {...props} />;
}

export { Input, INPUT_CLASS };
