import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded text-sm font-medium cursor-pointer select-none",
    "transition-[background-color,border-color,color,transform] duration-200 ease-out",
    "outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed",
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        // Primary CTA — ultra-premium with subtle depth
        default: [
          "relative text-primary-foreground font-semibold tracking-[0.005em]",
          "bg-primary",
          "border border-primary/60",
          "shadow-sm",
          "hover:bg-primary/95 hover:shadow",
          "active:bg-primary/85 active:scale-[0.985]",
          "transition-[background-color,border-color,color,transform] duration-200 ease-out",
        ].join(" "),

        // Success — uses design tokens
        success: [
          "relative text-success-foreground font-semibold tracking-[0.01em]",
          "bg-success",
          "border border-success/70",
          "shadow-sm",
          "hover:bg-success/90",
          "active:bg-success/80 active:scale-[0.98]",
        ].join(" "),

        // Destructive — uses design tokens
        destructive: [
          "relative text-destructive-foreground font-semibold tracking-[0.01em]",
          "bg-destructive",
          "border border-destructive/70",
          "shadow-sm",
          "hover:bg-destructive/90",
          "active:bg-destructive/80 active:scale-[0.98]",
        ].join(" "),

        // Outline — refined with subtle glassmorphism
        outline: [
          "relative font-medium",
          "text-foreground bg-muted/70 backdrop-blur-sm",
          "border border-border/70",
          "shadow-sm",
          "hover:bg-muted hover:border-border-hover",
          "active:scale-[0.985]",
          "dark:bg-surface-raised/90 dark:border-border-hover dark:hover:bg-surface-raised",
          "transition-[background-color,border-color,color,transform] duration-200 ease-out",
        ].join(" "),

        // Secondary — uses design tokens
        secondary: [
          "relative font-medium",
          "text-foreground bg-secondary",
          "border border-border/50",
          "hover:bg-muted",
          "active:scale-[0.98]",
          "dark:text-foreground/90 dark:bg-white/8 dark:border-white/5 dark:hover:bg-white/12",
        ].join(" "),

        // Ghost — uses design tokens
        ghost: [
          "font-medium",
          "text-foreground",
          "hover:bg-muted",
          "active:scale-[0.98]",
          "dark:text-foreground/90 dark:hover:bg-white/8",
        ].join(" "),

        // Link — uses design tokens
        link: [
          "font-medium",
          "text-primary",
          "hover:text-primary/80 hover:underline",
          "underline-offset-4",
        ].join(" "),

        // Social button for auth flows - ultra-premium glassmorphism
        social: [
          "relative font-medium",
          "text-foreground bg-surface-1/80 backdrop-blur-xl",
          "border border-border/60",
          "shadow-sm gap-2",
          "hover:bg-surface-2/90 hover:border-border-hover hover:shadow",
          "active:scale-[0.985] active:shadow-sm",
          "dark:bg-surface-raised/80 dark:border-border-hover dark:hover:bg-surface-raised/95",
          "transition-[background-color,border-color,color,transform] duration-200 ease-out",
        ].join(" "),
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs gap-1.5",
        lg: "h-12 px-6 text-sm",
        icon: "size-10",
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

export { Button, buttonVariants };
