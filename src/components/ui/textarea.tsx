import * as React from "react";

import { cn } from "../lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-md border border-transparent bg-input px-3.5 py-3 text-sm text-foreground shadow-none transition-colors duration-200 outline-none resize-y cursor-text",
          "placeholder:text-muted-foreground/60",
          "focus:border-border-active focus:ring-2 focus:ring-ring/15",
          "disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground",
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
