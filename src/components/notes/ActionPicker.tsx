import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "../icons";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../ui/dropdown-menu";
import {
  SPLIT_BUTTON_DIVIDER_CLASS,
  SPLIT_BUTTON_GROUP_CLASS,
  SPLIT_BUTTON_SEGMENT_CLASS,
} from "../ui/splitButton";
import { cn } from "../lib/utils";
import { getActionCta } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";
import { getActionIcon } from "./actionIcons";
import ActionMenuItems, { type ActionMenuItemsProps } from "./ActionMenuItems";

// The key the ask bar's picker has always used, so a remembered choice carries over.
const LAST_ACTION_KEY = "askBarActionId";

/** Runs the action last picked from it (the first action until then), or picks another. */
export default function ActionPicker({
  actions,
  canRun,
  onRunAction,
  onManageActions,
}: ActionMenuItemsProps) {
  const { t } = useTranslation();
  const [lastUsedId, setLastUsedId] = useState(() => Number(localStorage.getItem(LAST_ACTION_KEY)));
  const current = actions.find((action) => action.id === lastUsedId) ?? actions[0];

  const run = (action: ActionItem) => {
    setLastUsedId(action.id);
    localStorage.setItem(LAST_ACTION_KEY, String(action.id));
    onRunAction(action);
  };
  const Icon = getActionIcon(current);

  return (
    <div
      className={cn(
        SPLIT_BUTTON_GROUP_CLASS,
        "h-8 shrink-0 animate-[fade-in-content_0.25s_ease-out_backwards] motion-reduce:animate-none"
      )}
    >
      <button
        type="button"
        onClick={() => run(current)}
        disabled={!canRun(current)}
        className={cn(
          SPLIT_BUTTON_SEGMENT_CLASS,
          "gap-1.5 ps-3 pe-2.5 disabled:pointer-events-none disabled:opacity-40"
        )}
      >
        <Icon size={14} className="shrink-0 text-primary" />
        <span dir="auto" className="max-w-40 truncate">
          {getActionCta(current, t)}
        </span>
      </button>
      <span aria-hidden="true" className={SPLIT_BUTTON_DIVIDER_CLASS} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("notes.actions.selectAction")}
            className={cn(SPLIT_BUTTON_SEGMENT_CLASS, "w-8 justify-center")}
          >
            <ChevronDown size={13} className="text-foreground/60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" sideOffset={8} className="min-w-48">
          <ActionMenuItems
            actions={actions}
            canRun={canRun}
            onRunAction={run}
            onManageActions={onManageActions}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
