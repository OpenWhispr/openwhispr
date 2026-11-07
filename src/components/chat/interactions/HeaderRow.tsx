import type { ReactElement, ReactNode } from "react";

/**
 * One labelled line of an answer card's header: To, Subject, Channel, As.
 * `action` sits at its end (a copy button that shows while the line is pointed at).
 */
export function HeaderRow({
  label,
  children,
  action,
}: {
  label: string;
  children: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="group flex min-h-6 items-center gap-2">
      <span className="w-16 shrink-0 text-xs text-muted-foreground agent:w-auto agent:min-w-14 agent:text-[13px]">
        {label}
      </span>
      {children}
      {action}
    </div>
  );
}
