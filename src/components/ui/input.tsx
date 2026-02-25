import * as React from "react";

import { cn } from "../lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded border border-border/70 bg-input px-3 py-2 text-sm text-foreground shadow-none transition-colors duration-200 outline-none",
        "placeholder:text-muted-foreground/40",
        "selection:bg-primary selection:text-primary-foreground",
        "file:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted",
        "dark:bg-surface-1 dark:border-border-subtle/50",
        "hover:border-border-hover",
        "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/10",
        "dark:focus-visible:border-border-active dark:focus-visible:ring-ring/10",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  );
}

export { Input };
