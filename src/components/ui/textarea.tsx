import * as React from "react";

import { cn } from "../lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-xl border border-neutral-200 bg-white px-3.5 py-3 text-sm text-neutral-900 shadow-sm transition-colors duration-200 outline-none resize-y cursor-text",
          "placeholder:text-neutral-400",
          "hover:border-neutral-300",
          "focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-neutral-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
