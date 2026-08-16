import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/utils";

interface ExpandingPanelShellProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  open: boolean;
  anchor?: "bottom-left" | "bottom-right";
  children: ReactNode;
}

/** Shared surface for pill-to-panel transitions; callers own only their inner layout. */
export function ExpandingPanelShell({
  open,
  anchor = "bottom-right",
  children,
  className,
  ...props
}: ExpandingPanelShellProps) {
  return (
    <section
      className={cn(
        "expanding-panel-surface absolute inset-3 flex flex-col overflow-hidden",
        "rounded-3xl border border-border/50 bg-surface-0 backdrop-blur-xl",
        "shadow-[var(--shadow-modal)]",
        anchor === "bottom-left"
          ? "expanding-panel-anchor-bottom-left"
          : "expanding-panel-anchor-bottom-right",
        open && "expanding-panel-surface-open",
        className
      )}
      aria-hidden={!open}
      {...props}
    >
      {children}
    </section>
  );
}
