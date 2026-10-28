import { useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";

export interface SelectionAction {
  label: string;
  onClick: () => void;
  tone?: "default" | "destructive";
  busy?: boolean;
  disabled?: boolean;
}

interface SelectionBarProps {
  count: number;
  onClear: () => void;
  actions: SelectionAction[];
}

interface RowCheckboxProps {
  checked: boolean | "mixed";
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function SelectionBar({ count, onClear, actions }: SelectionBarProps): ReactElement | null {
  const { t } = useTranslation();
  if (count === 0) return null;
  // A running action settles the selection itself (failures stay selected), so nothing else may
  // change it meanwhile.
  const busy = actions.some((action) => action.busy);

  return (
    <div className="pointer-events-none sticky bottom-4 z-10 flex justify-center">
      <div
        role="region"
        aria-label={t("settingsPage.workspace.people.selection.label")}
        className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/70 bg-popover py-1 ps-4 pe-1 text-popover-foreground shadow-lg"
      >
        <span className="text-sm font-medium tabular-nums">
          {t("settingsPage.workspace.people.selection.count", { count })}
        </span>
        <span aria-hidden="true" className="mx-2 h-4 w-px bg-border" />
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClear}>
          {t("settingsPage.workspace.people.selection.clear")}
        </Button>
        {actions.map((action) => (
          <Button
            key={action.label}
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || action.disabled}
            onClick={action.onClick}
            className={cn(
              action.tone === "destructive" &&
                "text-destructive hover:bg-destructive/10 dark:text-destructive dark:hover:bg-destructive/15"
            )}
          >
            {action.busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** A native checkbox, so the browser draws the mixed state and announces it. */
export function RowCheckbox({
  checked,
  onChange,
  label,
  disabled,
}: RowCheckboxProps): ReactElement {
  const ref = useRef<HTMLInputElement>(null);
  const mixed = checked === "mixed";

  // `indeterminate` has no attribute, so React can't set it.
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);

  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked === true}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      className="size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50"
    />
  );
}
