import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const alertVariants = cva(
  "relative w-full rounded-xl border px-4 py-3 text-sm [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg~*]:pl-7",
  {
    variants: {
      variant: {
        default:
          "bg-neutral-50 border-neutral-200 text-neutral-900 [&>svg]:text-neutral-600 dark:bg-neutral-900 dark:border-neutral-700 dark:text-neutral-100 dark:[&>svg]:text-neutral-400",
        destructive:
          "bg-red-50 border-red-200 text-red-900 [&>svg]:text-red-600 dark:bg-red-950/40 dark:border-red-800 dark:text-red-100 dark:[&>svg]:text-red-400",
        success:
          "bg-emerald-50 border-emerald-200 text-emerald-900 [&>svg]:text-emerald-600 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-100 dark:[&>svg]:text-emerald-400",
        warning:
          "bg-amber-50 border-amber-200 text-amber-900 [&>svg]:text-amber-600 dark:bg-amber-950/40 dark:border-amber-800 dark:text-amber-100 dark:[&>svg]:text-amber-400",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5
      ref={ref}
      className={cn("mb-1 font-medium leading-none tracking-tight text-inherit", className)}
      {...props}
    />
  )
);
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("text-sm opacity-90 [&_p]:leading-relaxed", className)} {...props} />
));
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
