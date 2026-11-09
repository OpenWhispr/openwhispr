import type { ReactElement, ReactNode } from "react";
import type { IconComponent } from "../icons";

interface SettingRowProps {
  icon: IconComponent;
  title: string;
  body: string;
  /** A reason the control can't be used, under the body. */
  hint?: string;
  children: ReactNode;
}

// One line of a settings dialog's General panel: what it is on the left, the control that
// changes it on the right.
export function SettingRow({
  icon: Icon,
  title,
  body,
  hint,
  children,
}: SettingRowProps): ReactElement {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{title}</span>
        </p>
        <p className="mt-0.5 ps-[22px] text-xs text-muted-foreground">{body}</p>
        {hint && <p className="mt-0.5 ps-[22px] text-xs text-muted-foreground/70">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
