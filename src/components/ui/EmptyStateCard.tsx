import type { ComponentType, ReactNode } from "react";
import { cn } from "../lib/utils";

interface EmptyStateCardProps {
  icon: ComponentType<{ size?: number; className?: string }>;
  title?: string;
  description?: string;
  /** Announce the title as a heading when the card is the page's main content. */
  headingLevel?: 2 | 3;
  /** Actions or previews, stacked and centred under the copy. */
  children?: ReactNode;
  className?: string;
}

/** Card-shaped empty state: icon tile, title, one-line description, then the single next action. */
export default function EmptyStateCard({
  icon: Icon,
  title,
  description,
  headingLevel,
  children,
  className,
}: EmptyStateCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-2xl border border-default/70 bg-surface-primary/50 px-6 py-10 text-center dark:bg-surface-primary/60",
        className
      )}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-tertiary text-primary/70 dark:bg-surface-tertiary">
        <Icon size={20} />
      </span>
      {title && (
        <p
          role={headingLevel ? "heading" : undefined}
          aria-level={headingLevel}
          className="mt-4 text-[15px] font-medium text-primary"
        >
          {title}
        </p>
      )}
      {description && (
        <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-primary/70">{description}</p>
      )}
      {children && <div className="mt-5 flex flex-col items-center gap-2">{children}</div>}
    </div>
  );
}
