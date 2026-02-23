import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, ChevronDown, Settings2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import {
  useActions,
  initializeActions,
  getActionName,
  getActionDescription,
} from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";

interface ActionPickerProps {
  onRunAction: (action: ActionItem) => void;
  onManageActions: () => void;
  disabled?: boolean;
}

export default function ActionPicker({
  onRunAction,
  onManageActions,
  disabled,
}: ActionPickerProps) {
  const { t } = useTranslation();
  const actions = useActions();
  const [lastUsedId, setLastUsedId] = useState<number | null>(null);

  useEffect(() => {
    initializeActions();
    const stored = localStorage.getItem("lastUsedActionId");
    if (stored) setLastUsedId(Number(stored));
  }, []);

  const activeAction = actions.find((a) => a.id === lastUsedId) ?? actions[0] ?? null;

  const handleRun = (action: ActionItem) => {
    setLastUsedId(action.id);
    localStorage.setItem("lastUsedActionId", String(action.id));
    onRunAction(action);
  };

  if (!activeAction) return null;

  return (
    <div className="flex items-center">
      <button
        onClick={() => handleRun(activeAction)}
        disabled={disabled}
        aria-label={t("notes.actions.runAction", { name: getActionName(activeAction, t) })}
        className={cn(
          "flex items-center gap-2 h-11 pl-5 pr-3 rounded-l-xl",
          "bg-accent/8 dark:bg-accent/12",
          "backdrop-blur-xl",
          "border border-r-0 border-accent/15 dark:border-accent/20",
          "shadow-sm hover:shadow-md",
          "text-accent/70 hover:text-accent",
          "transition-[background-color,color,transform] duration-200",
          "hover:bg-accent/12 dark:hover:bg-accent/18",
          "active:scale-[0.98]",
          "disabled:opacity-40 disabled:pointer-events-none"
        )}
      >
        <Sparkles size={14} />
        <span className="text-xs font-semibold tracking-tight">
          {getActionName(activeAction, t)}
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            disabled={disabled}
            aria-label={t("notes.actions.selectAction")}
            className={cn(
              "flex items-center justify-center h-11 w-8 rounded-r-xl",
              "bg-accent/8 dark:bg-accent/12",
              "backdrop-blur-xl",
              "border border-l-0 border-accent/15 dark:border-accent/20",
              "shadow-sm hover:shadow-md",
              "text-accent/50 hover:text-accent",
              "transition-[background-color,color,transform] duration-200",
              "hover:bg-accent/15 dark:hover:bg-accent/22",
              "disabled:opacity-40 disabled:pointer-events-none"
            )}
          >
            <ChevronDown size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" sideOffset={8} className="min-w-48">
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.id}
              onClick={() => handleRun(action)}
              className={cn(
                "text-xs gap-2.5 rounded-md px-2.5 py-1.5",
                action.id === activeAction.id && "bg-accent/5"
              )}
            >
              <Sparkles size={12} className="text-accent/50 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{getActionName(action, t)}</div>
                {action.description && (
                  <div className="text-xs text-muted-foreground/50 truncate">
                    {getActionDescription(action, t)}
                  </div>
                )}
              </div>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onManageActions}
            className="text-xs gap-2.5 rounded-md px-2.5 py-1.5 text-muted-foreground/60"
          >
            <Settings2 size={12} />
            {t("notes.actions.manage")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
