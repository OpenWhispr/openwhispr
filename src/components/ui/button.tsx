import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils";
import { BRAND_GLASS_SURFACE } from "./gradientCircle";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-full text-sm font-medium cursor-pointer select-none",
    "transition-[background-color,border-color,color,transform] duration-200 ease-out",
    "outline-none focus-visible:ring-2 focus-visible:ring-focus/30 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-primary",
    "disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed",
    "[&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        // Primary CTA — brand glass capsule
        default: [
          "relative font-semibold tracking-[0.005em]",
          BRAND_GLASS_SURFACE,
          "hover:brightness-110",
          "active:brightness-95 active:scale-[0.985]",
          "transition-[filter,transform] duration-200 ease-out",
        ].join(" "),

        // Success — uses design tokens
        success: [
          "relative text-on-solid font-semibold tracking-[0.01em]",
          "bg-green-solid",
          "border border-green-solid/70",
          "shadow-sm",
          "hover:bg-green-solid/90",
          "active:bg-green-solid/80 active:scale-[0.98]",
        ].join(" "),

        // Destructive — uses design tokens
        destructive: [
          "relative text-on-solid font-semibold tracking-[0.01em]",
          "bg-red-solid",
          "border border-red-solid/70",
          "shadow-sm",
          "hover:bg-red-solid/90",
          "active:bg-red-solid/80 active:scale-[0.98]",
        ].join(" "),

        // Outline — refined with subtle glassmorphism
        outline: [
          "relative font-medium",
          "text-primary bg-surface-secondary/70 backdrop-blur-sm",
          "border border-default/70",
          "shadow-sm",
          "hover:bg-surface-secondary hover:border-hover",
          "active:scale-[0.985]",
          "dark:bg-surface-tertiary/90 dark:border-hover dark:hover:bg-surface-tertiary",
          "transition-[background-color,border-color,color,transform] duration-200 ease-out",
        ].join(" "),

        // Outline flat — transparent with thin border, no fill or shadow
        "outline-flat": [
          "font-medium",
          "text-secondary/70 bg-transparent",
          "border border-default/70",
          "hover:text-primary/80 hover:border-default hover:bg-text-primary/3",
          "active:scale-[0.98]",
          "dark:border-white/10 dark:hover:bg-white/5 dark:hover:border-white/15",
        ].join(" "),

        // Secondary — uses design tokens
        secondary: [
          "relative font-medium",
          "text-primary bg-surface-secondary",
          "border border-default/70",
          "hover:bg-surface-secondary",
          "active:scale-[0.98]",
          "dark:text-primary/90 dark:bg-white/8 dark:border-white/10 dark:hover:bg-white/12",
        ].join(" "),

        // Ghost — uses design tokens
        ghost: [
          "font-medium",
          "text-primary",
          "hover:bg-surface-secondary",
          "active:scale-[0.98]",
          "dark:text-primary/90 dark:hover:bg-white/8",
        ].join(" "),

        // Link — uses design tokens
        link: [
          "font-medium",
          "text-brand-solid",
          "hover:text-brand-solid/80 hover:underline",
          "underline-offset-4",
        ].join(" "),

        // Social button for auth flows - ultra-premium glassmorphism
        social: [
          "relative font-medium",
          "text-primary bg-surface-secondary/80 backdrop-blur-xl",
          "border border-default/70",
          "shadow-sm gap-2",
          "hover:bg-surface-primary/90 hover:border-hover hover:shadow",
          "active:scale-[0.985] active:shadow-sm",
          "dark:bg-surface-tertiary/80 dark:border-hover dark:hover:bg-surface-tertiary/95",
          "transition-[background-color,border-color,color,transform] duration-200 ease-out",
        ].join(" "),
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs gap-1.5",
        lg: "h-12 px-6 text-sm",
        // Icon buttons keep the 4px radius; the pill base is sized for text labels.
        icon: "size-10 rounded",
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
      data-variant={variant ?? "default"}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };
