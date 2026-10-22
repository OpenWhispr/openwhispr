import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { Eye, EyeOff, Pencil, Trash2, Users } from "../icons";
import { Input } from "../ui/input";
import { Tooltip } from "../ui/tooltip";
import { cn } from "../lib/utils";
import type { DictionaryRow } from "./dictionaryViewModel";
import type { EditFailure } from "./useDictionaryActions";
import { RowCheckbox } from "./RowCheckbox";

const ROW_HEIGHT = 38;
// Shorter lists render every row: virtualizing them saves nothing.
export const VIRTUALIZE_AFTER_ROWS = 200;
// Each hover action is 24px, with 2px between them and 8px to the row's edge.
const actionsWidth = (count: number): string => `${count * 26 + 6}px`;

// Latin layouts type "a" wherever their A key sits (AZERTY puts it on KeyQ);
// Cyrillic, Arabic and other layouts type their own letter there, so for them
// the physical key decides. A Latin letter on KeyA (AZERTY's Q) is never ⌘A.
function isSelectAllKey(event: KeyboardEvent<HTMLElement>): boolean {
  const key = event.key.toLowerCase();
  return key === "a" || (event.code === "KeyA" && !/^[a-z]$/.test(key));
}

export interface WordListSelection {
  isSelected: (key: string) => boolean;
  // Anything selected: every row shows its checkbox and the hover actions step aside.
  active: boolean;
  // extend is a Shift-click, which ticks the range from the last ticked row.
  onToggle: (row: DictionaryRow, extend: boolean) => void;
  onSelectAll: () => void;
  onClear: () => void;
}

interface DictionaryWordListProps {
  rows: DictionaryRow[];
  // Rows of the Hidden list, which can only be unhidden.
  hiddenList: boolean;
  // Resolves why the edit failed, to show under the open editor, or null to close it.
  onEdit: (row: DictionaryRow, word: string) => Promise<EditFailure | null>;
  onDelete: (row: DictionaryRow) => void;
  onHide: (row: DictionaryRow) => void;
  onDeleteForEveryone: (row: DictionaryRow) => void;
  onUnhide: (row: DictionaryRow) => void;
  // Personal rows only show Share once there is somewhere to share to. The
  // anchor is the clicked icon, which the share popover opens from.
  onShare?: (row: DictionaryRow, anchor: HTMLElement) => void;
  // Lists without bulk actions (Hidden) have no checkboxes.
  selection?: WordListSelection;
  // A paused list's words can be read, not changed: the rows have no actions.
  readOnly?: boolean;
  // The page's scroller, which a long list is virtualized against.
  getScrollElement?: () => HTMLElement | null;
}

// The row an action was taken on. Once it leaves the list (or its editor
// closes), focus lands nearby rather than on the page, so ⌘A keeps working.
interface PendingFocus {
  key: string;
  index: number;
  // A personal rename gets a new key; focus follows the new spelling.
  renamedTo?: string;
}

interface RowAction {
  // The tooltip stays short; the accessible name says which word it acts on.
  label: string;
  ariaLabel: string;
  icon: ReactNode;
  onClick: (anchor: HTMLElement) => void;
  destructive?: boolean;
}

function RowActionButton({ action }: { action: RowAction }): ReactElement {
  return (
    <Tooltip content={action.label}>
      <button
        type="button"
        aria-label={action.ariaLabel}
        onClick={(event) => action.onClick(event.currentTarget)}
        className={cn(
          "grid size-6 place-items-center rounded-[5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
          action.destructive
            ? "text-destructive/80 hover:bg-destructive/10 hover:text-destructive"
            : "text-foreground/55 hover:bg-foreground/6 hover:text-foreground/85 dark:hover:bg-white/8"
        )}
      >
        {action.icon}
      </button>
    </Tooltip>
  );
}

const BADGE_CLASS =
  "max-w-32 truncate rounded-[4px] bg-foreground/6 px-1.5 py-px text-[10px] text-foreground/55 dark:bg-white/8";

function RowMeta({ row }: { row: DictionaryRow }): ReactElement | null {
  const { t } = useTranslation();
  const attribution =
    row.attribution === "you"
      ? t("dictionary.shared.attribution.you")
      : row.attribution === "former"
        ? t("dictionary.shared.attribution.former")
        : (row.attribution?.name ?? null);
  const unused = row.kind === "shared" && !row.usedInDictation;
  if (!row.badge && !attribution && !unused) return null;
  return (
    <span className="flex shrink-0 items-center gap-2">
      {unused && (
        <Tooltip content={t("dictionary.shared.notUsedTooltip")}>
          <span data-not-used="" className={cn(BADGE_CLASS, "text-warning")}>
            {t("dictionary.shared.notUsed")}
            <span className="sr-only">. {t("dictionary.shared.notUsedTooltip")}</span>
          </span>
        </Tooltip>
      )}
      {attribution && (
        <span dir="auto" className="max-w-32 truncate text-[11px] text-foreground/45">
          {attribution}
        </span>
      )}
      {row.badge && (
        <span dir="auto" className={BADGE_CLASS}>
          {row.otherLists > 0
            ? t("dictionary.shared.badgeMore", { list: row.badge, extra: row.otherLists })
            : row.badge}
        </span>
      )}
    </span>
  );
}

function RowEditor({
  row,
  onCommit,
  onCancel,
}: {
  row: DictionaryRow;
  onCommit: (word: string) => Promise<EditFailure | null>;
  onCancel: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const errorId = useId();
  const [value, setValue] = useState(row.word);
  const [error, setError] = useState<EditFailure | null>(null);
  const [saving, setSaving] = useState(false);

  // Enter keeps the focus here, so any failure stays on screen. Leaving the
  // field drops a refusal (the word can't be saved as typed), but a save that
  // failed stays open with its text and error, without pulling the focus back
  // from wherever the user went; Esc and Enter work again once they return.
  const commit = async (fromBlur: boolean): Promise<void> => {
    if (saving) return;
    if (fromBlur && error) {
      // A failed save stays open until the text changes, rather than retrying on every blur.
      if (error.refused) onCancel();
      return;
    }
    // An empty word is never sent: the editor stays open until it has one.
    if (value.trim() === "") {
      if (fromBlur) onCancel();
      return;
    }
    setSaving(true);
    let failure: EditFailure | null = null;
    try {
      failure = await onCommit(value.trim());
    } finally {
      setSaving(false);
    }
    if (!failure) return;
    if (fromBlur && failure.refused) {
      onCancel();
      return;
    }
    setError(failure);
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Input
        dir="auto"
        autoFocus
        value={value}
        // readOnly rather than disabled, so a refused save keeps the focus here.
        readOnly={saving}
        aria-label={t("dictionary.editWord", { word: row.word })}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit(false);
          if (event.key === "Escape") onCancel();
        }}
        onBlur={() => void commit(true)}
        className="h-7 min-w-0 flex-1 rounded-md text-xs"
      />
      {error && (
        <span id={errorId} className="shrink-0 text-[11px] text-destructive">
          {error.message}
        </span>
      )}
    </div>
  );
}

export function DictionaryWordList({
  rows,
  hiddenList,
  onEdit,
  onDelete,
  onHide,
  onDeleteForEveryone,
  onUnhide,
  onShare,
  selection,
  readOnly = false,
  getScrollElement,
}: DictionaryWordListProps): ReactElement {
  const { t } = useTranslation();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  const pendingFocus = useRef<PendingFocus | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtualized = rows.length > VIRTUALIZE_AFTER_ROWS && getScrollElement !== undefined;

  // The row being edited and the row holding focus stay rendered when they
  // scroll out of view, so neither the typed text nor the focus is lost.
  const pinned = [editingKey, focusedKey]
    .map((key) => (key === null ? -1 : rows.findIndex((row) => row.key === key)))
    .filter((index) => index >= 0)
    .join(",");
  const rangeExtractor = useCallback(
    (range: Range): number[] => {
      const indexes = new Set(defaultRangeExtractor(range));
      for (const index of pinned ? pinned.split(",") : []) indexes.add(Number(index));
      return [...indexes].sort((left, right) => left - right);
    },
    [pinned]
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => getScrollElement?.() ?? null,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index].key,
    overscan: 12,
    scrollMargin,
    rangeExtractor,
    enabled: virtualized,
  });

  // Where the list starts inside the page's scroller, which moves as the
  // fields above it open and close.
  const measureScrollMargin = useCallback((): void => {
    const list = listRef.current;
    const scroller = getScrollElement?.();
    if (!list || !scroller || typeof list.getBoundingClientRect !== "function") return;
    const margin =
      list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    setScrollMargin((previous) => (Math.abs(previous - margin) < 0.5 ? previous : margin));
  }, [getScrollElement]);

  // Measured once the list virtualizes, then whenever the page's content
  // resizes (a field above opening or closing), never on a scroll.
  useLayoutEffect(() => {
    const scroller = getScrollElement?.();
    if (!virtualized || !scroller) return;
    measureScrollMargin();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureScrollMargin);
    observer.observe(scroller.firstElementChild ?? scroller);
    return () => observer.disconnect();
  }, [virtualized, getScrollElement, measureScrollMargin]);

  // Hide and delete finish after a round trip, so this waits for the row to
  // go. Focus the user moved elsewhere meanwhile stays where they put it.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || editingKey === pending.key) return;
    const active = document.activeElement;
    const focusLost = !active || !document.body.contains(active);
    const focusRow = (row: DictionaryRow | undefined): void => {
      const element = row ? rowElements.current.get(row.key) : undefined;
      (element?.querySelector("button") ?? listRef.current)?.focus();
    };
    const index = rows.findIndex((row) => row.key === pending.key);
    if (index >= 0) {
      if (!focusLost) return;
      // A closed editor leaves the row in place; a rename's row leaves once the
      // dictionary saves, so focus keeps following it until then.
      focusRow(rows[index]);
      if (pending.renamedTo === undefined) pendingFocus.current = null;
      return;
    }
    pendingFocus.current = null;
    if (!focusLost) return;
    const renamed = rows.find((row) => row.word === pending.renamedTo);
    focusRow(renamed ?? rows[Math.min(pending.index, rows.length - 1)]);
  }, [rows, editingKey]);

  const focusNearAfter = (row: DictionaryRow, renamedTo?: string): void => {
    pendingFocus.current = {
      key: row.key,
      index: rows.findIndex((candidate) => candidate.key === row.key),
      renamedTo,
    };
  };

  // Only while the list itself has focus: the add field and the row editor keep
  // ⌘A for their text. preventDefault also keeps Edit → Select All from
  // selecting the page's text, in the Hidden list too, which has no selection.
  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if ((event.metaKey || event.ctrlKey) && isSelectAllKey(event)) {
      event.preventDefault();
      selection?.onSelectAll();
    } else if (event.key === "Escape" && selection?.active) {
      event.preventDefault();
      selection.onClear();
    }
  };

  const handleBlur = (event: FocusEvent<HTMLUListElement>): void => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setFocusedKey(null);
  };

  const actionsFor = (row: DictionaryRow): RowAction[] => {
    const action = (
      labelKey: string,
      ariaLabelKey: string,
      icon: ReactNode,
      onClick: (anchor: HTMLElement) => void,
      destructive = false
    ): RowAction => ({
      label: t(labelKey),
      ariaLabel: t(ariaLabelKey, { word: row.word }),
      icon,
      onClick,
      destructive,
    });
    const edit = action(
      "dictionary.shared.actions.edit",
      "dictionary.editWord",
      <Pencil size={13} />,
      () => setEditingKey(row.key)
    );
    if (hiddenList) {
      return [
        action(
          "dictionary.shared.actions.unhide",
          "dictionary.shared.actions.unhideWord",
          <Eye size={13} />,
          () => {
            focusNearAfter(row);
            onUnhide(row);
          }
        ),
      ];
    }
    if (row.kind === "personal") {
      const share = onShare
        ? [
            action(
              "dictionary.shared.actions.share",
              "dictionary.shared.actions.shareWord",
              <Users size={13} />,
              (anchor) => onShare(row, anchor)
            ),
          ]
        : [];
      return [
        ...share,
        edit,
        action(
          "dictionary.shared.actions.delete",
          "dictionary.shared.actions.deleteWord",
          <Trash2 size={13} />,
          () => {
            focusNearAfter(row);
            onDelete(row);
          }
        ),
      ];
    }
    return [
      edit,
      action(
        "dictionary.shared.actions.hide",
        "dictionary.shared.actions.hideWord",
        <EyeOff size={13} />,
        () => {
          focusNearAfter(row);
          onHide(row);
        }
      ),
      action(
        "dictionary.shared.actions.deleteForEveryone",
        "dictionary.shared.actions.deleteForEveryoneWord",
        <Trash2 size={13} />,
        () => {
          focusNearAfter(row);
          onDeleteForEveryone(row);
        },
        true
      ),
    ];
  };

  const renderRow = (row: DictionaryRow, index: number, style?: CSSProperties): ReactElement => {
    const editing = editingKey === row.key;
    const selected = selection?.isSelected(row.key) ?? false;
    const showActions = !selection?.active && !readOnly;
    const actions = showActions ? actionsFor(row) : [];
    return (
      <li
        key={row.key}
        ref={(element) => {
          if (element) rowElements.current.set(row.key, element);
          else rowElements.current.delete(row.key);
        }}
        data-word={row.word}
        aria-setsize={virtualized ? rows.length : undefined}
        aria-posinset={virtualized ? index + 1 : undefined}
        onFocus={() => setFocusedKey(row.key)}
        style={
          showActions
            ? ({ ...style, "--row-actions-width": actionsWidth(actions.length) } as CSSProperties)
            : style
        }
        className={cn(
          "group relative -mx-2 flex h-[38px] items-center gap-2 rounded-md px-2",
          index < rows.length - 1 && "border-b border-foreground/4 dark:border-white/6",
          virtualized && "absolute inset-x-0 top-0",
          selected
            ? "bg-primary/8 dark:bg-primary/12"
            : "hover:bg-foreground/[0.025] dark:hover:bg-white/[0.03]"
        )}
      >
        {selection && (
          // A fixed column, so ticking the first row shifts nothing.
          <RowCheckbox
            checked={selected}
            label={t("dictionary.shared.selection.selectWord", { word: row.word })}
            onToggle={(event) => selection.onToggle(row, event.shiftKey)}
            className={cn(
              "size-5 shrink-0 justify-center transition-opacity duration-150",
              selection.active
                ? "opacity-100"
                : "opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
            )}
          />
        )}
        {editing ? (
          <RowEditor
            row={row}
            onCancel={() => setEditingKey(null)}
            onCommit={async (word) => {
              const failure = await onEdit(row, word);
              if (!failure) {
                focusNearAfter(row, row.kind === "personal" ? word : undefined);
                setEditingKey(null);
              }
              return failure;
            }}
          />
        ) : (
          <>
            <span
              dir="auto"
              className={cn(
                "min-w-0 flex-1 truncate text-xs text-foreground/75",
                // The hover actions sit over the row's end; the word stops short of them.
                showActions &&
                  "group-focus-within:pe-[var(--row-actions-width)] group-hover:pe-[var(--row-actions-width)]"
              )}
            >
              {row.word}
            </span>
            <span className={cn(showActions && "group-focus-within:hidden group-hover:hidden")}>
              <RowMeta row={row} />
            </span>
            {showActions && (
              <div className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                {actions.map((action) => (
                  <RowActionButton key={action.label} action={action} />
                ))}
              </div>
            )}
          </>
        )}
      </li>
    );
  };

  return (
    // Focusable so a click on a row gives the list focus for ⌘A.
    <ul
      ref={listRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className={cn("outline-none", virtualized && "relative")}
      style={virtualized ? { height: virtualizer.getTotalSize() } : undefined}
    >
      {virtualized
        ? virtualizer.getVirtualItems().map((item) =>
            renderRow(rows[item.index], item.index, {
              transform: `translateY(${item.start - scrollMargin}px)`,
            })
          )
        : rows.map((row, index) => renderRow(row, index))}
    </ul>
  );
}
