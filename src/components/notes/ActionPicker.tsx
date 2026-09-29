import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, ChevronDown, Settings2, MessageSquareText } from "../icons";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import { getActionName, getActionCta, getActionDescription } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";
import { FOLLOW_UP_EMAIL_KEY } from "../../helpers/builtinActions";

// Keyed fresh so the follow-up email default reaches installs that had
// "Generate Notes" remembered under the old key.
const ASK_BAR_ACTION_KEY = "askBarActionId";

interface ActionPickerProps {
  /** Actions only; templates have their own picker. */
  actions: ActionItem[];
  onRunAction: (action: ActionItem) => void;
  onManageActions: () => void;
  disabled?: boolean;
  /** A summary action waits while another run is writing the summary. */
  isSummaryBusy: boolean;
  /** A chat action waits for the reply the chat is still writing. */
  isChatBusy: boolean;
}

export default function ActionPicker({
  actions,
  onRunAction,
  onManageActions,
  disabled,
  isSummaryBusy,
  isChatBusy,
}: ActionPickerProps) {
  const { t } = useTranslation();
  const [lastUsedId, setLastUsedId] = useState<number | null>(() => {
    const stored = localStorage.getItem(ASK_BAR_ACTION_KEY);
    return stored ? Number(stored) : null;
  });
  const canRun = (action: ActionItem) =>
    action.output === "summary" ? !isSummaryBusy : !isChatBusy;

  const activeAction =
    actions.find((a) => a.id === lastUsedId) ??
    actions.find((a) => a.translation_key === FOLLOW_UP_EMAIL_KEY) ??
    actions[0] ??
    null;

  const handleRun = (action: ActionItem) => {
    setLastUsedId(action.id);
    localStorage.setItem(ASK_BAR_ACTION_KEY, String(action.id));
    onRunAction(action);
  };

  if (!activeAction) return null;

  return (
    <div
      className={cn(
        "flex items-center shrink-0 rounded-full overflow-hidden",
        "bg-white/60 dark:bg-white/8",
        "backdrop-blur-lg transform-gpu",
        "border border-black/10 dark:border-white/14",
        "shadow-(--shadow-glass)",
        disabled && "opacity-40 pointer-events-none"
      )}
    >
      <button
        onClick={() => handleRun(activeAction)}
        disabled={disabled || !canRun(activeAction)}
        aria-label={t("notes.actions.runAction", { name: getActionName(activeAction, t) })}
        className={cn(
          "flex items-center gap-1.5 h-7 ps-3 pe-1.5",
          "text-accent/70 dark:text-accent/60",
          "transition-colors duration-150",
          "hover:bg-accent/8 dark:hover:bg-accent/12",
          "hover:text-accent/90 dark:hover:text-accent/80"
        )}
      >
        <Sparkles size={11} />
        <span className="text-[11px] font-semibold tracking-tight">
          {getActionCta(activeAction, t)}
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            disabled={disabled}
            aria-label={t("notes.actions.selectAction")}
            className={cn(
              "flex items-center justify-center h-7 w-6 pe-0.5",
              "border-s border-black/6 dark:border-white/10",
              "text-accent/40 dark:text-accent/30",
              "transition-colors duration-150",
              "hover:bg-accent/8 dark:hover:bg-accent/12",
              "hover:text-accent/70"
            )}
          >
            <ChevronDown size={10} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" sideOffset={8} className="min-w-48">
          {actions.map((action) => {
            const editsSummary = action.output === "summary";
            const OutputIcon = editsSummary ? Sparkles : MessageSquareText;
            return (
              <DropdownMenuItem
                key={action.id}
                onClick={() => handleRun(action)}
                disabled={!canRun(action)}
                className={cn(
                  "text-xs gap-2.5 rounded-md px-2.5 py-1.5",
                  action.id === activeAction.id && "bg-accent/5"
                )}
              >
                <OutputIcon size={12} className="text-accent/50 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium truncate">{getActionName(action, t)}</span>
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
