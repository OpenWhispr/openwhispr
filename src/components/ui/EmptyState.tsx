import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

interface EmptyStateProps {
  icon?: LucideIcon;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** CTA slot — pass Button elements; primary first, optional secondary after. */
  actions?: React.ReactNode;
  /** Tight variant for dropdowns, popovers, and small panels. */
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actions,
  compact = false,
  className,
}: EmptyStateProps) {
  if (!Icon && !title && !description && !actions) return null;

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "px-4 py-6" : "px-6 py-12",
        className
      )}
    >
      {Icon &&
        (compact ? (
          <Icon
            size={16}
            strokeWidth={1.5}
            aria-hidden="true"
            className="mb-2 text-muted-foreground/50"
          />
        ) : (
          <div className="mb-3 flex size-10 shrink-0 items-center justify-center rounded-full bg-muted dark:bg-white/5">
            <Icon
              size={18}
              strokeWidth={1.5}
              aria-hidden="true"
              className="text-muted-foreground/60"
            />
          </div>
        ))}
      {title != null && (
        <h3
          className={cn(
            "font-medium text-foreground",
            compact ? "text-xs" : "text-sm",
            description != null && "mb-1"
          )}
        >
          {title}
        </h3>
      )}
      {description != null && (
        <div
          className={cn(
            "text-xs leading-relaxed",
            compact
              ? "max-w-[260px] text-muted-foreground/60"
              : "max-w-[300px] text-muted-foreground"
          )}
        >
          {description}
        </div>
      )}
      {actions && (
        <div
          className={cn(
            "flex flex-wrap items-center justify-center gap-2",
            compact ? "mt-3" : "mt-4"
          )}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
