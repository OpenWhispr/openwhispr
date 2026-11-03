import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { FileText, FolderOpen, MoreHorizontal, Search, X } from "../icons";
import { defaultFolderDisplayName } from "./shared";
import { formatRelativeTime } from "../../utils/dateFormatting";
import { folderContainerKey, loadContainerNotes } from "../../stores/noteStore";
import { cn } from "../lib/utils";
import type { FolderItem, NoteItem } from "../../types/electron";
import type { RowA11yProps } from "./SpacesTree";

interface Props {
  folder: FolderItem;
  total: number;
  hiddenCount: number;
  activeNoteId: number | null;
  level: 2 | 3;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  a11y: RowA11yProps;
  onPick: (note: NoteItem, keyboard: boolean) => void;
  onOpenFolder: () => void;
}

export function FolderNotesPopover({
  folder,
  total,
  hiddenCount,
  activeNoteId,
  level,
  open,
  onOpenChange,
  a11y,
  onPick,
  onOpenFolder,
}: Props) {
  const { t, i18n } = useTranslation();
  const [allNotes, setAllNotes] = useState<NoteItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keyboardRef = useRef(false);
  const pickedNoteRef = useRef(false);
  const titleId = useId();
  const name = defaultFolderDisplayName(folder, t);

  useEffect(() => {
    if (!open) return;
    pickedNoteRef.current = false;
    setQuery("");
    let stale = false;
    setAllNotes(null);
    setFailed(false);
    // SQLite LIMIT -1 removes the normal 50-note container cap.
    loadContainerNotes(folderContainerKey(folder.id), null, -1)
      .then((items) => {
        if (!stale) setAllNotes(items);
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [open, folder.id, reload]);

  const filtered = (allNotes ?? []).filter((note) =>
    note.title
      .toLocaleLowerCase(i18n.language)
      .includes(query.trim().toLocaleLowerCase(i18n.language))
  );
  const highlightTitle = (title: string) => {
    const value = query.trim();
    const index = title
      .toLocaleLowerCase(i18n.language)
      .indexOf(value.toLocaleLowerCase(i18n.language));
    if (!value || index < 0) return title;
    return (
      <>
        {title.slice(0, index)}
        <span className="font-semibold text-primary">
          {title.slice(index, index + value.length)}
        </span>
        {title.slice(index + value.length)}
      </>
    );
  };
  const pick = (note: NoteItem, keyboard = true) => {
    pickedNoteRef.current = true;
    onPick(note, keyboard);
    onOpenChange(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setQuery("");
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <div
          role="treeitem"
          aria-level={level}
          aria-label={t("notes.folderMore.more", { count: hiddenCount })}
          ref={a11y.rowRef}
          tabIndex={a11y.tabIndex}
          onKeyDown={(event) => {
            keyboardRef.current = true;
            a11y.onKeyDown(event);
          }}
          onPointerDown={() => {
            keyboardRef.current = false;
          }}
          onFocus={a11y.onFocus}
          className={cn(
            "flex h-7 items-center gap-2 rounded-md pe-2 text-xs cursor-pointer select-none outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-ring/30",
            level === 2 ? "ps-8" : "ps-[42px]",
            open
              ? "bg-foreground/8 text-foreground dark:bg-white/10"
              : "text-foreground/55 hover:bg-foreground/5 hover:text-foreground dark:hover:bg-white/5"
          )}
        >
          <MoreHorizontal size={13} aria-hidden="true" />
          <span>{t("notes.folderMore.more", { count: hiddenCount })}</span>
        </div>
      </PopoverTrigger>
      <PopoverContent
        side={i18n.dir() === "rtl" ? "left" : "right"}
        align="start"
        className="flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-24px)] flex-col p-2 rounded-xl"
        aria-labelledby={titleId}
        onKeyDownCapture={() => {
          keyboardRef.current = true;
        }}
        onPointerDownCapture={() => {
          keyboardRef.current = false;
        }}
        onEscapeKeyDown={() => {
          keyboardRef.current = true;
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          // Picking a note hands focus back to the tree on keyboard paths only.
          // Restoring focus after a pointer click can inherit the search input's
          // :focus-visible state and leave a ring on the closed trigger.
          if (pickedNoteRef.current || !keyboardRef.current) event.preventDefault();
        }}
      >
        <div className="relative">
          <Search
            size={14}
            aria-hidden="true"
            className="absolute start-3 top-2.5 text-muted-foreground"
          />
          <Input
            dir="auto"
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("notes.folderMore.search", { count: total, folder: name })}
            placeholder={t("notes.folderMore.search", { count: total, folder: name })}
            className="input-inline h-8 rounded-full bg-foreground/5 ps-9 pe-8 text-xs dark:bg-white/5"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                listRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
              }
              if (event.key === "Enter" && filtered[0]) {
                event.preventDefault();
                pick(filtered[0]);
              }
            }}
          />
          {query && (
            <button
              type="button"
              aria-label={t("meetingNotification.folders.clear")}
              className="absolute end-2 top-2 rounded-sm text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        <p id={titleId} className="px-2 py-2 text-[11px] text-muted-foreground">
          {query.trim()
            ? t("notes.folderMore.results", { count: filtered.length, total })
            : t("notes.folderMore.newest")}
        </p>
        <div
          ref={listRef}
          className="min-h-0 max-h-64 overflow-y-auto space-y-px"
          aria-busy={!allNotes && !failed}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const buttons = Array.from(
              listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []
            );
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === "ArrowUp" && index === 0) {
              inputRef.current?.focus();
              return;
            }
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : index + (event.key === "ArrowDown" ? 1 : -1);
            buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus();
          }}
        >
          {failed ? (
            <Button variant="ghost" size="sm" onClick={() => setReload((value) => value + 1)}>
              {t("notes.folderMore.retry")}
            </Button>
          ) : !allNotes ? (
            <p role="status" className="p-3 text-xs text-muted-foreground">
              {t("notes.folderMore.loading")}
            </p>
          ) : filtered.length === 0 ? (
            <p
              role="status"
              className="flex min-h-40 flex-col items-center justify-center gap-3 p-6 text-center text-xs text-muted-foreground"
            >
              <Search size={24} aria-hidden="true" />
              {t("notes.folderMore.empty")}
            </p>
          ) : (
            filtered.map((note) => (
              <button
                key={note.id}
                type="button"
                onClick={(event) => pick(note, event.detail === 0)}
                aria-current={note.id === activeNoteId ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-start outline-none hover:bg-foreground/5 focus-visible:bg-foreground/8 focus-visible:ring-1 focus-visible:ring-ring/30",
                  note.id === activeNoteId && "bg-primary/8 text-primary"
                )}
              >
                <FileText size={13} aria-hidden="true" className="shrink-0" />
                <span dir="auto" className="truncate flex-1">
                  {highlightTitle(note.title || t("notes.list.untitled"))}
                </span>
                <time
                  dateTime={note.updated_at}
                  className="shrink-0 text-[11px] text-muted-foreground"
                >
                  {formatRelativeTime(note.updated_at, t, i18n.language)}
                </time>
              </button>
            ))
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-2 w-full rounded-full text-xs"
          onClick={() => {
            onOpenFolder();
            onOpenChange(false);
          }}
        >
          <FolderOpen size={13} aria-hidden="true" />
          {t("notes.folderMore.openFolder")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
