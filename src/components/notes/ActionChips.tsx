import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Blocks, TextCursorInput } from "../icons";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "../ui/dropdown-menu";
import { cn } from "../lib/utils";
import { getActionName, getActionDescription } from "../../stores/actionStore";
import type { ActionItem } from "../../types/electron";
import ActionMenuItems, { ActionOutputBadge, type ActionMenuItemsProps } from "./ActionMenuItems";
import { getActionIcon } from "./actionIcons";

const VISIBLE_CHIPS = 4;

const CHIP_CLASS = cn(
  "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs text-foreground/60",
  // A disabled chip still takes the pointer, so moving onto one moves the card to it.
  "enabled:hover:bg-foreground/[0.07] enabled:hover:text-foreground disabled:cursor-default disabled:text-foreground/30 disabled:[&_svg]:opacity-40 dark:enabled:hover:bg-white/[0.08]",
  "transition-colors duration-150 focus:outline-none focus-visible:bg-foreground/6 focus-visible:text-foreground",
  "animate-[fade-in-up_0.32s_cubic-bezier(0.22,1,0.36,1)_backwards] motion-reduce:animate-none"
);

// The docked chat's tray: filled pills on the tray.
const DOCKED_CHIP_CLASS = cn(
  CHIP_CLASS,
  "bg-background text-foreground/70 dark:bg-surface-1",
  "enabled:hover:bg-surface-3 focus-visible:bg-surface-3 dark:enabled:hover:bg-surface-2 dark:focus-visible:bg-surface-2"
);

const CHIP_ICON_CLASS = "shrink-0 text-primary";

const chipEntrance = (index: number) => ({ animationDelay: `${140 + index * 40}ms` });

interface ActionChipsProps extends ActionMenuItemsProps {
  /** The docked chat's look: filled pills on its tray. */
  docked?: boolean;
  /** A first pill that writes the note's AI summary; absent when the note has no template to run. */
  generateSummary?: { run: () => void; disabled: boolean };
}

/**
 * The first actions as one-click chips, and every action behind "All actions": at the end of
 * the row, or at its start in the docked chat.
 * A hovered or focused chip shows what its action does above the row.
 */
export default function ActionChips({
  actions,
  canRun,
  onRunAction,
  onManageActions,
  docked = false,
  generateSummary,
}: ActionChipsProps) {
  const { t } = useTranslation();
  const [previewed, setPreviewed] = useState<ActionItem | null>(null);
  const description = previewed && getActionDescription(previewed, t);
  const chipClass = docked ? DOCKED_CHIP_CLASS : CHIP_CLASS;
  const PreviewedIcon = previewed && getActionIcon(previewed);
  // Docked, All actions leads the row and scrolls with the chips, opening toward them.
  const firstChip = (docked ? 1 : 0) + (generateSummary ? 1 : 0);
  const allActions = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onPointerEnter={() => setPreviewed(null)}
          className={chipClass}
          style={chipEntrance(docked ? 0 : firstChip + Math.min(actions.length, VISIBLE_CHIPS))}
        >
          <Blocks size={14} className={CHIP_ICON_CLASS} />
          {t("notes.actions.allActions")}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={docked ? "start" : "end"}
        side="top"
        sideOffset={8}
        // The docked chat sits 24px in from the window's edge; the menu stays inside that too.
        collisionPadding={docked ? 24 : undefined}
        className="min-w-48"
      >
        <ActionMenuItems
          actions={actions}
          canRun={canRun}
          onRunAction={onRunAction}
          onManageActions={onManageActions}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="relative">
      {previewed && (
        <div className="pointer-events-none absolute bottom-full start-0 z-10 mb-2 flex w-full max-w-md items-center gap-3 rounded-2xl border border-black/[0.06] bg-popover p-3 shadow-(--shadow-chat-card) animate-[fade-in-up_0.18s_ease-out] motion-reduce:animate-none dark:border-white/10">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-foreground/6">
            {PreviewedIcon && <PreviewedIcon size={16} className="text-primary" />}
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
        {/* In the in-view chat only the chips scroll, so All actions at the end stays in reach. */}
        <div
          className={cn(
            "scrollbar-hidden flex min-w-0 flex-1 items-center overflow-x-auto pe-6",
            docked ? "gap-1.5" : "gap-1",
            "[mask-image:linear-gradient(to_right,#000_calc(100%_-_1.5rem),transparent)] rtl:[mask-image:linear-gradient(to_left,#000_calc(100%_-_1.5rem),transparent)]"
          )}
        >
          {docked && allActions}
          {generateSummary && (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={generateSummary.run}
              onPointerEnter={() => setPreviewed(null)}
              disabled={generateSummary.disabled}
              className={chipClass}
              style={chipEntrance(docked ? 1 : 0)}
            >
              <TextCursorInput size={14} className={CHIP_ICON_CLASS} />
              {t("embeddedChat.generateSummary")}
            </button>
          )}
          {actions.slice(0, VISIBLE_CHIPS).map((action, index) => {
            const Icon = getActionIcon(action);
            return (
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
                className={chipClass}
                style={chipEntrance(firstChip + index)}
              >
                <Icon size={14} className={CHIP_ICON_CLASS} />
                <span dir="auto">{getActionName(action, t)}</span>
              </button>
            );
          })}
        </div>
        {!docked && allActions}
      </div>
    </div>
  );
}
