import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium tracking-wide transition-colors focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-brand-solid/15 text-brand-solid dark:bg-brand-solid/10 dark:ring-1 dark:ring-brand-solid/20",
        secondary:
          "border-transparent bg-surface-secondary text-primary hover:bg-surface-secondary/80",
        destructive:
          "border-transparent bg-red-solid/15 text-red-solid dark:ring-1 dark:ring-red-solid/20",
        outline: "text-secondary border-default dark:border-hover",
        success:
          "border-transparent bg-green-solid/15 text-green-solid dark:ring-1 dark:ring-green-solid/20",
        warning:
          "border-transparent bg-amber-solid/15 text-amber-solid dark:ring-1 dark:ring-amber-solid/20",
        info: "border-transparent bg-brand-solid/15 text-brand-solid dark:ring-1 dark:ring-brand-solid/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge };
