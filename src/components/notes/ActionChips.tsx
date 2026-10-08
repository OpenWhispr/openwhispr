import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Blocks, SquareSlash } from "../icons";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import { getActionName, getActionDescription } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";
import ActionMenuItems, { ActionOutputBadge, type ActionMenuItemsProps } from "./ActionMenuItems";

const VISIBLE_CHIPS = 4;

const CHIP_CLASS = cn(
  "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs text-foreground/60",
  // A disabled chip still takes the pointer, so moving onto one moves the card to it.
  "enabled:hover:bg-foreground/[0.07] enabled:hover:text-foreground disabled:cursor-default disabled:text-foreground/30 dark:enabled:hover:bg-white/[0.08]",
  "transition-colors duration-150 focus:outline-none focus-visible:bg-foreground/6 focus-visible:text-foreground",
  "animate-[fade-in-up_0.32s_cubic-bezier(0.22,1,0.36,1)_backwards] motion-reduce:animate-none"
);

const chipEntrance = (index: number) => ({ animationDelay: `${140 + index * 40}ms` });

/**
 * The first actions as one-click chips, then every action behind "All actions" at the end.
 * A hovered or focused chip shows what its action does above the row.
 */
export default function ActionChips({
  actions,
  canRun,
  onRunAction,
  onManageActions,
}: ActionMenuItemsProps) {
  const { t } = useTranslation();
  const [previewed, setPreviewed] = useState<ActionItem | null>(null);
  const description = previewed && getActionDescription(previewed, t);

  return (
    <div className="relative">
      {previewed && (
        <div className="pointer-events-none absolute bottom-full start-0 z-10 mb-2 flex w-full max-w-md items-center gap-3 rounded-2xl border border-black/[0.06] bg-popover p-3 shadow-(--shadow-chat-card) animate-[fade-in-up_0.18s_ease-out] motion-reduce:animate-none dark:border-white/10">
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
      <div onPointerLeave={() => setPreviewed(null)} className="flex items-center gap-1">
        {/* Only the chips scroll, so All actions stays in reach in a narrow chat. */}
        <div className="scrollbar-hidden flex min-w-0 flex-1 items-center gap-1 overflow-x-auto pe-6 [mask-image:linear-gradient(to_right,#000_calc(100%_-_1.5rem),transparent)] rtl:[mask-image:linear-gradient(to_left,#000_calc(100%_-_1.5rem),transparent)]">
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
              // Pointer, not mouse: React drops mouse events on disabled buttons.
              onPointerEnter={() => setPreviewed(action)}
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
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onPointerEnter={() => setPreviewed(null)}
              className={CHIP_CLASS}
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
