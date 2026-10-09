import { useTranslation } from "react-i18next";
import { Settings2 } from "../icons";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { getActionName, getActionDescription } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";
import { getActionIcon } from "./actionIcons";

export interface ActionMenuItemsProps {
  /** Actions only; templates have their own picker. */
  actions: ActionItem[];
  canRun: (action: ActionItem) => boolean;
  onRunAction: (action: ActionItem) => void;
  onManageActions: () => void;
}

/** Where an action's output goes: the note's chat or its AI summary. */
export function ActionOutputBadge({ action }: { action: ActionItem }) {
  const { t } = useTranslation();
  return (
    <span className="text-[10px] font-medium px-1 py-px rounded bg-foreground/5 dark:bg-white/6 text-muted-foreground/70 shrink-0">
      {t(
        action.output === "summary" ? "notes.actions.output.summary" : "notes.actions.output.chat"
      )}
    </span>
  );
}

/** Every action with where its output goes, then Manage Actions, as a dropdown's items. */
export default function ActionMenuItems({
  actions,
  canRun,
  onRunAction,
  onManageActions,
}: ActionMenuItemsProps) {
  const { t } = useTranslation();

  return (
    <>
      {actions.map((action) => {
        const Icon = getActionIcon(action);
        return (
          <DropdownMenuItem
            key={action.id}
            onClick={() => onRunAction(action)}
            disabled={!canRun(action)}
            className="text-xs gap-2.5 rounded-md px-2.5 py-1.5"
          >
            <Icon size={14} className="shrink-0 text-primary" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span dir="auto" className="font-medium truncate">
                  {getActionName(action, t)}
                </span>
                <ActionOutputBadge action={action} />
              </div>
              <div className="text-xs text-muted-foreground/70 truncate">
                {getActionDescription(action, t)}
              </div>
            </div>
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={onManageActions}
        className="text-xs gap-2.5 rounded-md px-2.5 py-1.5 text-muted-foreground/70"
      >
        <Settings2 size={12} />
        {t("notes.actions.manage")}
      </DropdownMenuItem>
    </>
  );
}
