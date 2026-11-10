import type { ReactElement, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { useCallCardPlacement } from "../callCardContext";

/**
 * One labelled line of an answer card's header: To, Subject, Channel, As.
 * `action` sits at its end (a copy button that shows while the line is pointed at).
 * In a call the lines are rows of the header's grid, so their values line up.
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
  const inCall = useCallCardPlacement() !== null;
  return (
    <div
      className={cn(
        "group min-h-6 items-center",
        inCall ? "col-span-full grid min-h-7 grid-cols-subgrid" : "flex gap-2"
      )}
    >
      <span
        className={cn(
          "shrink-0 text-xs text-muted-foreground agent:text-[13px]",
          !inCall && "w-16 agent:w-auto agent:min-w-14"
        )}
      >
        {label}
      </span>
      {children}
      {action}
    </div>
  );
}
