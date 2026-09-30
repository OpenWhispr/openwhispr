import { useTranslation } from "react-i18next";
import { Blocks, Settings2, Sparkles, MessageSquareText } from "../icons";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { getActionName, getActionDescription } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";
import { ASK_PILL_CLASS } from "./shared";
import { getActionIcon } from "./actionIcons";

const VISIBLE_CHIPS = 4;

interface ActionChipsProps {
  /** Actions only; templates have their own picker. */
  actions: ActionItem[];
  canRun: (action: ActionItem) => boolean;
  onRunAction: (action: ActionItem) => void;
  onManageActions: () => void;
}

/** The first actions as one-click chips, then every action behind "All actions". */
export default function ActionChips({
  actions,
  canRun,
  onRunAction,
  onManageActions,
}: ActionChipsProps) {
  const { t } = useTranslation();

  return (
    <div className="scrollbar-hidden flex items-center justify-center-safe gap-1.5 overflow-x-auto">
      {actions.slice(0, VISIBLE_CHIPS).map((action) => {
        const Icon = getActionIcon(action);
        return (
          <button
            key={action.id}
            type="button"
            // Keep focus in the composer, so an open chat can take a follow-up right away.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onRunAction(action)}
            disabled={!canRun(action)}
            className={ASK_PILL_CLASS}
          >
            <Icon size={11} className="shrink-0 text-foreground/45" />
            <span dir="auto">{getActionName(action, t)}</span>
          </button>
        );
      })}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={ASK_PILL_CLASS}>
            <Blocks size={11} className="shrink-0 text-foreground/45" />
            {t("notes.actions.allActions")}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" sideOffset={8} className="min-w-48">
          {actions.map((action) => {
            const editsSummary = action.output === "summary";
            const OutputIcon = editsSummary ? Sparkles : MessageSquareText;
            return (
              <DropdownMenuItem
                key={action.id}
                onClick={() => onRunAction(action)}
                disabled={!canRun(action)}
                className="text-xs gap-2.5 rounded-md px-2.5 py-1.5"
              >
                <OutputIcon size={12} className="text-accent/50 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span dir="auto" className="font-medium truncate">
                      {getActionName(action, t)}
                    </span>
                    <span className="text-[10px] font-medium px-1 py-px rounded bg-foreground/5 dark:bg-white/6 text-muted-foreground/70 shrink-0">
                      {t(
                        editsSummary ? "notes.actions.output.summary" : "notes.actions.output.chat"
                      )}
                    </span>
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
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
