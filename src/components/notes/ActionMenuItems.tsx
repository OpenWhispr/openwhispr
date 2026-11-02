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

/** Every action, then Manage Actions, as a dropdown's items. */
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
              <div className="font-medium truncate">
                <span dir="auto">{getActionName(action, t)}</span>
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
