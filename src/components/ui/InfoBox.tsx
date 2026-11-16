import React from "react";
import { cn } from "../lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const infoBoxVariants = cva("rounded-md border p-4 transition-colors", {
  variants: {
    variant: {
      default:
        "bg-brand-solid/8 border-brand-solid/20 dark:bg-brand-solid/10 dark:border-brand-solid/20",
      success:
        "bg-green-solid/8 border-green-solid/20 dark:bg-green-solid/10 dark:border-green-solid/20",
      warning:
        "bg-amber-solid/8 border-amber-solid/20 dark:bg-amber-solid/10 dark:border-amber-solid/20",
      info: "bg-brand-solid/8 border-brand-solid/20 dark:bg-brand-solid/10 dark:border-brand-solid/20",
      muted: "bg-surface-secondary border-default",
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
