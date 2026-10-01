import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Blocks, SquareSlash } from "../icons";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import { getActionName, getActionDescription } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";
import ActionMenuItems, { ActionOutputBadge } from "./ActionMenuItems";

const VISIBLE_CHIPS = 4;

const CHIP_CLASS = cn(
  "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs text-foreground/60",
  // A disabled chip still takes the pointer, so moving onto one moves the card to it.
  "enabled:hover:bg-foreground/6 enabled:hover:text-foreground disabled:cursor-default disabled:text-foreground/30",
  "transition-colors duration-150 focus:outline-none focus-visible:bg-foreground/6 focus-visible:text-foreground",
  "animate-[fade-in-up_0.32s_cubic-bezier(0.22,1,0.36,1)_backwards] motion-reduce:animate-none"
);

// The chips rise in one after another as the chat finishes opening.
const chipEntrance = (index: number) => ({ animationDelay: `${140 + index * 40}ms` });

interface ActionChipsProps {
  /** Actions only; templates have their own picker. */
  actions: ActionItem[];
  canRun: (action: ActionItem) => boolean;
  onRunAction: (action: ActionItem) => void;
  onManageActions: () => void;
}

/**
 * The first actions as one-click chips, then every action behind "All actions" at the end.
 * A hovered or focused chip shows what its action does above the row.
 */
export default function ActionChips({
  actions,
  canRun,
  onRunAction,
  onManageActions,
}: ActionChipsProps) {
  const { t } = useTranslation();
  const [previewed, setPreviewed] = useState<ActionItem | null>(null);
  const description = previewed && getActionDescription(previewed, t);

  return (
    <div className="relative">
      {previewed && (
        <div className="pointer-events-none absolute bottom-full start-0 z-10 mb-2 flex w-full max-w-md items-center gap-3 rounded-2xl border border-border/70 bg-popover p-3 shadow-lg animate-[fade-in-up_0.18s_ease-out] motion-reduce:animate-none dark:border-white/10">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/6">
            <SquareSlash size={16} className="text-foreground/70" />
          </span>
          <span className="min-w-0 flex-1">
            <span dir="auto" className="block truncate text-sm font-medium text-foreground">
              {getActionName(previewed, t)}
            </span>
            {description && (
              <span dir="auto" className="block truncate text-xs text-muted-foreground">
                {description}
              </span>
            )}
          </span>
          <ActionOutputBadge action={previewed} />
        </div>
      )}
      {/* Left as a row, so moving between chips swaps the card instead of replaying it. */}
      <div
        onMouseLeave={() => setPreviewed(null)}
        className="scrollbar-hidden flex items-center gap-1 overflow-x-auto"
      >
        {actions.slice(0, VISIBLE_CHIPS).map((action, index) => (
          <button
            key={action.id}
            type="button"
            // Keep focus in the composer, so an open chat can take a follow-up right away.
            onMouseDown={(event) => event.preventDefault()}
            // Running it disables the chips, so the card would otherwise sit over the reply.
            onClick={() => {
              setPreviewed(null);
              onRunAction(action);
            }}
            onMouseEnter={() => setPreviewed(action)}
            onFocus={() => setPreviewed(action)}
            onBlur={() => setPreviewed(null)}
            disabled={!canRun(action)}
            className={CHIP_CLASS}
            style={chipEntrance(index)}
          >
            <SquareSlash size={13} className="shrink-0" />
            <span dir="auto">{getActionName(action, t)}</span>
          </button>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onMouseEnter={() => setPreviewed(null)}
              className={cn(CHIP_CLASS, "ms-auto")}
              style={chipEntrance(Math.min(actions.length, VISIBLE_CHIPS))}
            >
              <Blocks size={13} className="shrink-0" />
              {t("notes.actions.allActions")}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" sideOffset={8} className="min-w-48">
            <ActionMenuItems
              actions={actions}
              canRun={canRun}
              onRunAction={onRunAction}
              onManageActions={onManageActions}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
