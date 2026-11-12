import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, X, type IconComponent } from "../icons";
import { cn } from "../lib/utils";
import { RAISED_PILL } from "./dialogButtons";

export interface SelectionAction {
  /** Stable across label changes, so a busy label doesn't remount the button and drop its focus. */
  id: string;
  label: string;
  onClick: () => void;
  tone?: "destructive";
  busy?: boolean;
  icon?: IconComponent;
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
const PILL =
  "inline-flex items-center gap-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40";

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
    // Full width under the list, as the design docks it; sticky so a tab that scrolls as a whole
    // keeps it in view.
    <div className="sticky bottom-0 z-10 shrink-0 bg-background pt-3">
      <div
        role="region"
        aria-label={t("settingsPage.workspace.people.selection.label")}
        className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-1 px-3 py-2 shadow-[0_1px_4px_rgba(0,0,0,0.08)] dark:border-border-subtle"
      >
        <div className={cn("flex h-[34px] items-center rounded-full", RAISED_PILL)}>
          <span className="ps-4 pe-2 text-xs font-medium tabular-nums text-muted-foreground">
            {t("settingsPage.workspace.people.selection.count", { count })}
          </span>
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={busy ? undefined : onClear}
            className={cn(
              PILL,
              WHILE_BUSY,
              "h-full rounded-e-full border-s border-border ps-2.5 pe-3 text-link hover:bg-foreground/5 dark:border-border-subtle"
            )}
          >
            <X className="size-3.5" aria-hidden="true" />
            {t("settingsPage.workspace.people.selection.clear")}
          </button>
        </div>
        <div className="flex items-center gap-2.5">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <button
                key={action.id}
                type="button"
                aria-disabled={busy || undefined}
                onClick={busy ? undefined : action.onClick}
                className={cn(
                  PILL,
                  WHILE_BUSY,
                  "h-[34px] rounded-full ps-2.5 pe-3",
                  action.tone === "destructive"
                    ? "bg-destructive/10 text-destructive hover:bg-destructive/15"
                    : cn(RAISED_PILL, "text-muted-foreground hover:text-foreground")
                )}
              >
                {action.busy ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : Icon ? (
                  <Icon className="size-3.5" aria-hidden="true" />
                ) : null}
                {action.label}
              </button>
            );
          })}
          {trailing}
        </div>
      </div>
    </div>
  );
}
