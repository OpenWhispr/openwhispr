import React from "react";
import { cn } from "../lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

/* Quiet notice strips — sunken fill only, never fill + border.
   Default is neutral; tinted variants are reserved for true state messages. */
const infoBoxVariants = cva("rounded-md p-3 transition-colors", {
  variants: {
    variant: {
      default: "bg-muted text-muted-foreground",
      success: "bg-success/8 dark:bg-success/10",
      warning: "bg-warning/8 dark:bg-warning/10",
      info: "bg-info/8 dark:bg-info/10",
      muted: "bg-muted text-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface InfoBoxProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof infoBoxVariants> {}

export function InfoBox({ variant, className, children, ...props }: InfoBoxProps) {
  return (
    <div className={cn(infoBoxVariants({ variant }), className)} {...props}>
      {children}
    </div>
  );
}
