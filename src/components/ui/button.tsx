import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

/* Design language v2 — every action is a small, dense, monochrome capsule.
   Emphasis levels: inverse fill (primary) > hairline outline > sunken fill (quiet) > ghost.
   No shadows, no glassmorphism; hover/active step the fill, disabled drops contrast. */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-full text-sm font-medium cursor-pointer select-none",
    "transition-[background-color,border-color,color,transform] duration-200 ease-out",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:cursor-not-allowed",
    "disabled:bg-muted disabled:text-muted-foreground disabled:border-transparent",
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        // Primary — brand blue capsule
        default: [
          "text-primary-foreground bg-primary",
          "hover:bg-primary/90",
          "active:bg-primary/85 active:scale-[0.98]",
        ].join(" "),

        // Success — solid state color, flat
        success: [
          "text-success-foreground bg-success",
          "hover:bg-success/90",
          "active:bg-success/85 active:scale-[0.98]",
        ].join(" "),

        // Destructive — solid state color, flat
        destructive: [
          "text-destructive-foreground bg-destructive",
          "hover:bg-destructive/90",
          "active:bg-destructive/85 active:scale-[0.98]",
        ].join(" "),

        // Outline — hairline capsule
        outline: [
          "text-foreground bg-transparent",
          "border border-border",
          "hover:bg-muted hover:border-border-hover",
          "active:scale-[0.98]",
        ].join(" "),

        // Outline flat — quieter hairline capsule
        "outline-flat": [
          "text-muted-foreground bg-transparent",
          "border border-border-subtle",
          "hover:text-foreground hover:border-border hover:bg-muted/60",
          "active:scale-[0.98]",
        ].join(" "),

        // Secondary — sunken capsule
        secondary: [
          "text-foreground bg-secondary",
          "hover:bg-surface-raised",
          "active:scale-[0.98]",
        ].join(" "),

        // Ghost — text only, fill appears on hover
        ghost: [
          "text-foreground",
          "hover:bg-muted",
          "active:scale-[0.98]",
          "disabled:bg-transparent",
        ].join(" "),

        // Link — accent is reserved for links and selection
        link: [
          "text-link",
          "hover:text-link/80 hover:underline",
          "underline-offset-4",
          "disabled:bg-transparent",
        ].join(" "),

        // Social (auth flows) — raised capsule with hairline
        social: [
          "text-foreground bg-surface-2",
          "border border-border",
          "hover:bg-surface-1 hover:border-border-hover",
          "active:scale-[0.98]",
          "dark:bg-surface-raised dark:hover:bg-surface-3",
        ].join(" "),
      },
      size: {
        default: "h-9 px-5 py-2",
        xs: "h-7 px-3.5 text-xs gap-1.5",
        sm: "h-8 px-3.5 text-xs gap-1.5",
        lg: "h-10 px-6 text-sm",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };
