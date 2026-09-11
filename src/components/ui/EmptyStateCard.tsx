import type { ComponentType, ReactNode } from "react";
import { cn } from "../lib/utils";

interface EmptyStateCardProps {
  icon: ComponentType<{ size?: number; className?: string }>;
  title?: string;
  description?: string;
  /** Actions or previews, stacked and centred under the copy. */
  children?: ReactNode;
  className?: string;
}

/** Card-shaped empty state: icon tile, title, one-line description, then the single next action. */
export default function EmptyStateCard({
  icon: Icon,
  title,
  description,
  children,
  className,
}: EmptyStateCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-2xl border border-border/70 bg-card/50 px-6 py-10 text-center dark:border-white/10 dark:bg-surface-2/60",
        className
      )}
    >
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-3 text-foreground/70 dark:bg-surface-3">
        <Icon size={20} />
      </span>
      {title && <p className="mt-4 text-[15px] font-medium text-foreground">{title}</p>}
      {description && (
        <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-foreground/70">
          {description}
        </p>
      )}
      {children && <div className="mt-5 flex flex-col items-center gap-2">{children}</div>}
    </div>
  );
}
