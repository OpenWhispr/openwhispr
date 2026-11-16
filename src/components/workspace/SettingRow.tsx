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
    <div className="flex items-center gap-1 rounded-[9px] p-1">
      <div className="flex min-w-0 flex-1 items-start gap-1">
        <span className="grid size-5 shrink-0 place-items-center">
          <Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1 text-sm leading-[21px]">
          <p className="truncate font-medium text-foreground">{title}</p>
          <p className="text-muted-foreground">{body}</p>
          {hint && <p className="text-muted-foreground/70">{hint}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}
