import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import type { ShareTarget } from "../../services/sharedDictionaryActions";
import type { shareTargetsFor } from "./dictionaryViewModel";
import { isTermLikeSharedWord } from "../../utils/sharedDictionaryHints";
import { RowCheckbox } from "./RowCheckbox";

export type ShareTargetOption = ReturnType<typeof shareTargetsFor>[number];

interface ShareWordsPopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // What the popover opens from: a row's Share icon or the selection bar's button.
  anchor: HTMLElement | null;
  words: string[];
  targets: ShareTargetOption[];
  // Resolves once the share has finished, whatever its outcome; the caller reports it.
  onShare: (targets: ShareTarget[]) => Promise<void>;
}

// A space id, or "" for the workspace list, so targets fit in a Set of strings.
const targetKey = (target: ShareTarget): string => target ?? "";

export function ShareWordsPopover({
  open,
  onOpenChange,
  anchor,
  words,
  targets,
  onShare,
}: ShareWordsPopoverProps): ReactElement {
  const { t } = useTranslation();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [sharing, setSharing] = useState(false);
  const anchorRef = useMemo(() => ({ current: anchor }), [anchor]);

  // Each opening starts with nothing ticked.
  useEffect(() => {
    if (open) setTicked(new Set());
  }, [open, anchor]);

  const toggle = (target: ShareTarget): void => {
    setTicked((current) => {
      const next = new Set(current);
      const key = targetKey(target);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const chosen = targets
    .filter((option) => !option.alreadyShared && ticked.has(targetKey(option.target)))
    .map((option) => option.target);

  // A teammate's dictation would leave these out, so they stay in Personal; with
  // other words beside them, the share goes ahead and reports them by name.
  const nothingShareable = !words.some((word) => isTermLikeSharedWord(word));

  const share = async (): Promise<void> => {
    if (sharing || chosen.length === 0 || nothingShareable) return;
    setSharing(true);
    try {
      await onShare(chosen);
    } finally {
      setSharing(false);
    }
  };

  const title =
    words.length === 1
      ? t("dictionary.shared.share.titleOne", { word: words[0] })
      : t("dictionary.shared.share.titleMany", { count: words.length });

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {anchor && <PopoverAnchor virtualRef={anchorRef as { current: HTMLElement }} />}
      <PopoverContent
        align="end"
        className="w-60 min-w-0 p-1.5"
        // There's no trigger to return to, so focus goes back to what opened the popover.
        onCloseAutoFocus={(event) => {
          if (!anchor?.isConnected) return;
          event.preventDefault();
          anchor.focus();
        }}
        // The anchor toggles the popover itself; an outside click there would reopen it.
        onInteractOutside={(event) => {
          if (anchor && event.target instanceof Node && anchor.contains(event.target)) {
            event.preventDefault();
          }
        }}
      >
        <p
          dir="auto"
          className="truncate px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-foreground/45"
        >
          {title}
        </p>
        <div className="flex flex-col">
          {targets.map((option) => {
            const checked = !option.alreadyShared && ticked.has(targetKey(option.target));
            return (
              <RowCheckbox
                key={targetKey(option.target)}
                checked={checked}
                disabled={option.alreadyShared || sharing}
                onToggle={() => toggle(option.target)}
                className={cn(
                  "h-8 w-full gap-2 px-2 text-start text-xs transition-colors",
                  option.alreadyShared
                    ? "opacity-45"
                    : "hover:bg-foreground/5 dark:hover:bg-white/6"
                )}
              >
                <span dir="auto" className="min-w-0 flex-1 truncate text-foreground/85">
                  {option.label}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-foreground/45">
                  {option.alreadyShared
                    ? t("dictionary.shared.share.alreadyShared")
                    : option.memberCount}
                </span>
              </RowCheckbox>
            );
          })}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 border-t border-foreground/8 px-2 pb-0.5 pt-2 dark:border-white/8">
          {nothingShareable ? (
            <span role="alert" className="min-w-0 text-[10px] leading-snug text-destructive">
              {t("dictionary.shared.notTermLike")}
            </span>
          ) : (
            <span className="min-w-0 truncate text-[10px] text-foreground/45">
              {/* A pronoun, not a count: "it" for one word, "them" for several. */}
              {t(
                words.length === 1
                  ? "dictionary.shared.share.movesOutOne"
                  : "dictionary.shared.share.movesOutMany"
              )}
            </span>
          )}
          <Button
            size="sm"
            className="h-6 shrink-0 rounded-md px-2.5 text-[11px]"
            disabled={chosen.length === 0 || sharing || nothingShareable}
            onClick={() => void share()}
          >
            {t("dictionary.shared.actions.share")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
