import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "../icons";
import { cn } from "../lib/utils";
import { Button } from "../ui/button";

export interface SelectionAction {
  /** Stable across label changes, so a busy label doesn't remount the button and drop its focus. */
  id: string;
  label: string;
  onClick: () => void;
  tone?: "destructive";
  busy?: boolean;
}

interface SelectionBarProps {
  count: number;
  onClear: () => void;
  actions: SelectionAction[];
  /**
   * A control that isn't a plain button (a menu), after the actions. The busy state of the actions
   * doesn't reach it; whatever it opens holds the screen itself.
   */
  trailing?: ReactNode;
}

// aria-disabled rather than disabled: disabling the focused button would drop keyboard focus to the
// page, and whoever pressed Resend invites would have to find their way back to retry.
const WHILE_BUSY = "aria-disabled:pointer-events-none aria-disabled:opacity-50";

export function SelectionBar({
  count,
  onClear,
  actions,
  trailing,
}: SelectionBarProps): ReactElement | null {
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
        className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-1 rounded-2xl border border-border/70 bg-popover py-1 ps-4 pe-1 text-popover-foreground shadow-lg"
      >
        <span className="text-sm font-medium tabular-nums">
          {t("settingsPage.workspace.people.selection.count", { count })}
        </span>
        <span aria-hidden="true" className="mx-2 h-4 w-px bg-border" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-disabled={busy || undefined}
          onClick={busy ? undefined : onClear}
          className={WHILE_BUSY}
        >
          {t("settingsPage.workspace.people.selection.clear")}
        </Button>
        {actions.map((action) => (
          <Button
            key={action.id}
            type="button"
            variant="ghost"
            size="sm"
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : action.onClick}
            className={cn(
              WHILE_BUSY,
              action.tone === "destructive" &&
                "text-destructive hover:bg-destructive/10 dark:text-destructive dark:hover:bg-destructive/15"
            )}
          >
            {action.busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            {action.label}
          </Button>
        ))}
        {trailing}
      </div>
    </div>
  );
}
