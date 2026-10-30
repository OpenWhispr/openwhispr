import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, X } from "../icons";
import { cn } from "../lib/utils";

// The bar is 40px on one line and taller when its buttons wrap on a narrow window.
const DEFAULT_BAR_HEIGHT = 40;

interface SelectionActionBarProps {
  // Every selected row, including those a search hides.
  count: number;
  // The rows shown, which Select all adds.
  total: number;
  allShownSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  // Personal words in the selection: Delete, and Share once there's a list to share to.
  onDelete?: () => void;
  onShare?: (anchor: HTMLElement) => void;
  shareOpen?: boolean;
  // Shared words in the selection.
  onHide?: () => void;
  // While a Hide for me is in flight, so a second click doesn't send it again.
  hideBusy?: boolean;
  onDeleteForEveryone?: () => void;
  // The bottom padding the list needs while the bar floats over it: the bar
  // plus 8px on each side, so it never covers the last row.
  onClearanceChange?: (clearance: number) => void;
}

const QUIET_BUTTON_CLASS =
  "rounded-[5px] px-1 text-[11px] text-background/70 transition-colors enabled:hover:text-background disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/40";
const SOLID_BUTTON_CLASS =
  "flex h-6 items-center gap-1 rounded-md bg-background px-2.5 text-[11px] font-medium transition-colors hover:bg-background/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background/40";

function QuietButton({
  onClick,
  children,
  ariaLabel,
  className,
  disabled = false,
}: {
  onClick: () => void;
  children: ReactNode;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className={cn(QUIET_BUTTON_CLASS, className)}
    >
      {children}
    </button>
  );
}

export function SelectionActionBar({
  count,
  total,
  allShownSelected,
  onSelectAll,
  onClear,
  onDelete,
  onShare,
  shareOpen = false,
  onHide,
  hideBusy = false,
  onDeleteForEveryone,
  onClearanceChange,
}: SelectionActionBarProps): ReactElement {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(DEFAULT_BAR_HEIGHT);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(bar.offsetHeight || DEFAULT_BAR_HEIGHT));
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  useEffect(() => onClearanceChange?.(height + 16), [height, onClearanceChange]);

  return (
    <div
      ref={barRef}
      role="group"
      aria-label={t("dictionary.shared.selection.label")}
      // Pulled up across the column's 12px gap so it floats inside the list's
      // clearance, 8px above the list's bottom edge.
      style={{ marginTop: -(height + 20) }}
      className="sticky bottom-3 z-20 flex min-h-10 w-[min(100%,40rem)] flex-wrap items-center justify-between gap-x-3 gap-y-1 self-center rounded-lg bg-foreground py-1.5 ps-3 pe-2 text-background shadow-lg animate-in fade-in-0 slide-in-from-bottom-2"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
        <span aria-live="polite" className="shrink-0 font-medium tabular-nums">
          {t("dictionary.shared.selection.count", { count })}
        </span>
        {!allShownSelected && total > 0 && (
          <>
            <span aria-hidden="true" className="text-background/40">
              ·
            </span>
            <span className="truncate">
              <QuietButton onClick={onSelectAll}>
                {t("dictionary.shared.selection.selectAll", { total })}
              </QuietButton>
            </span>
          </>
        )}
      </span>
      <span className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-x-2.5 gap-y-1">
        {onHide && (
          <QuietButton onClick={onHide} disabled={hideBusy}>
            {t("dictionary.shared.actions.hide")}
          </QuietButton>
        )}
        {onDelete && (
          <QuietButton onClick={onDelete}>{t("dictionary.shared.actions.delete")}</QuietButton>
        )}
        {onShare && (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={shareOpen}
            onClick={(event) => onShare(event.currentTarget)}
            className={cn(SOLID_BUTTON_CLASS, "text-foreground")}
          >
            {t("dictionary.shared.selection.shareWith")}
            <ChevronDown size={11} />
          </button>
        )}
        {onDeleteForEveryone && (
          <button
            type="button"
            onClick={onDeleteForEveryone}
            className={cn(SOLID_BUTTON_CLASS, "text-destructive")}
          >
            {t("dictionary.shared.actions.deleteForEveryone")}
          </button>
        )}
        <QuietButton
          onClick={onClear}
          ariaLabel={t("dictionary.shared.selection.clear")}
          className="grid size-6 place-items-center px-0"
        >
          <X size={12} />
        </QuietButton>
      </span>
    </div>
  );
}
