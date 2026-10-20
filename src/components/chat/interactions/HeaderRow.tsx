import type { ReactElement, ReactNode } from "react";

/** One labelled line of an answer card's header: To, Subject, Channel, As. */
export function HeaderRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-h-6 items-center gap-2">
      <span className="w-14 shrink-0 text-[13px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
