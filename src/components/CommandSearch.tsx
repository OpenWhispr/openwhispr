import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search, FileText, Mic, Folder, Users, Upload } from "lucide-react";
import { cn } from "./lib/utils";
import type { NoteItem, FolderItem, TranscriptionItem } from "../types/electron.js";
import { normalizeDbDate } from "../utils/dateFormatting";

export interface CommandSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transcriptions: TranscriptionItem[];
  onNoteSelect: (noteId: number) => void;
  onTranscriptSelect: (transcriptId: number) => void;
}

type FlatItem =
  | { kind: "note"; note: NoteItem }
  | { kind: "transcript"; transcript: TranscriptionItem };

function relativeTime(
  dateStr: string,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const date = normalizeDbDate(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return t("notes.list.timeNow");
  if (minutes < 60) return t("notes.list.minutesAgo", { count: minutes });
  if (hours < 24) return t("notes.list.hoursAgo", { count: hours });
  if (days < 7) return t("notes.list.daysAgo", { count: days });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function stripMarkdownPreview(text: string): string {
  return text
    .replace(/#{1,6}\s+/g, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .trim();
}

export default function CommandSearch({
  open,
  onOpenChange,
  transcriptions,
  onNoteSelect,
  onTranscriptSelect,
}: CommandSearchProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    window.electronAPI
      .getFolders()
      .then(setFolders)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    window.electronAPI
      .getNotes()
      .then(setNotes)
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (!query.trim()) {
      window.electronAPI
        .getNotes()
        .then(setNotes)
        .catch(() => {});
      return;
    }

    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await window.electronAPI.searchNotes(query);
        setNotes(results);
      } catch {
        // keep current results
      }
    }, 200);

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [notes, query]);

  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  const noteGroups = useMemo(() => {
    const groups = new Map<number | null, NoteItem[]>();
    for (const note of notes) {
      const fid = note.folder_id ?? null;
      if (!groups.has(fid)) groups.set(fid, []);
      groups.get(fid)!.push(note);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => {
        if (a === null) return -1;
        if (b === null) return 1;
        const fa = folderMap.get(a);
        const fb = folderMap.get(b);
        if (fa?.is_default) return -1;
        if (fb?.is_default) return 1;
        return (fa?.sort_order ?? 0) - (fb?.sort_order ?? 0);
      })
      .map(([fid, items]) => ({
        folder: fid !== null ? (folderMap.get(fid) ?? null) : null,
        items,
      }));
  }, [notes, folderMap]);

  const filteredTranscripts = useMemo(() => {
    const slice = query.trim()
      ? transcriptions.filter((tr) => tr.text.toLowerCase().includes(query.toLowerCase()))
      : transcriptions;
    return slice.slice(0, 5);
  }, [transcriptions, query]);

  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    for (const group of noteGroups) {
      for (const note of group.items) items.push({ kind: "note", note });
    }
    for (const transcript of filteredTranscripts) items.push({ kind: "transcript", transcript });
    return items;
  }, [noteGroups, filteredTranscripts]);

  const selectItem = useCallback(
    (item: FlatItem) => {
      if (item.kind === "note") onNoteSelect(item.note.id);
      else onTranscriptSelect(item.transcript.id);
      onOpenChange(false);
    },
    [onNoteSelect, onTranscriptSelect, onOpenChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, flatItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = flatItems[selectedIndex];
        if (item) selectItem(item);
      }
    },
    [flatItems, selectedIndex, selectItem]
  );

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const hasResults = flatItems.length > 0;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[18%] z-50 w-full max-w-xl translate-x-[-50%]",
            "rounded-xl border border-border/60 bg-card shadow-2xl overflow-hidden",
            "dark:bg-surface-2 dark:border-border dark:shadow-modal",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "data-[state=open]:slide-in-from-top-[44%] data-[state=closed]:slide-out-to-top-[44%]",
            "data-[state=open]:slide-in-from-left-1/2 data-[state=closed]:slide-out-to-left-1/2"
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            {t("commandSearch.title")}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t("commandSearch.description")}
          </DialogPrimitive.Description>

          {/* Search input */}
          <div className="flex items-center gap-2.5 px-3.5 py-3 border-b border-border/40">
            <Search size={14} className="shrink-0 text-muted-foreground/50" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("commandSearch.placeholder")}
              autoFocus
              className="flex-1 text-sm text-foreground placeholder:text-muted-foreground/40"
              style={{
                background: "transparent",
                border: "none",
                outline: "none",
                boxShadow: "none",
                padding: 0,
              }}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="text-[11px] text-muted-foreground/40 hover:text-muted-foreground transition-colors outline-none"
              >
                ✕
              </button>
            )}
          </div>

          {/* Results list */}
          <div ref={listRef} className="overflow-y-auto max-h-[340px] p-1.5">
            {!hasResults ? (
              <div className="flex items-center justify-center py-10">
                <p className="text-xs text-muted-foreground/50">
                  {query.trim() ? t("commandSearch.noResults") : t("commandSearch.emptyState")}
                </p>
              </div>
            ) : (
              <>
                {noteGroups.length > 0 && (
                  <div>
                    {noteGroups.map((group) => {
                      const label = group.folder?.name ?? t("commandSearch.sections.notes");
                      const Icon = group.folder ? Folder : FileText;
                      return (
                        <div key={group.folder?.id ?? "null-folder"}>
                          <SectionHeader icon={<Icon size={11} />} label={label} />
                          {group.items.map((note) => {
                            const idx = flatItems.findIndex(
                              (fi) => fi.kind === "note" && fi.note.id === note.id
                            );
                            return (
                              <NoteRow
                                key={note.id}
                                note={note}
                                idx={idx}
                                isSelected={selectedIndex === idx}
                                onSelect={() => selectItem({ kind: "note", note })}
                                onHover={() => setSelectedIndex(idx)}
                                t={t}
                              />
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}

                {filteredTranscripts.length > 0 && (
                  <div className={noteGroups.length > 0 ? "mt-0.5" : ""}>
                    <SectionHeader
                      icon={<Mic size={11} />}
                      label={t("commandSearch.sections.transcripts")}
                    />
                    {filteredTranscripts.map((transcript) => {
                      const idx = flatItems.findIndex(
                        (fi) => fi.kind === "transcript" && fi.transcript.id === transcript.id
                      );
                      return (
                        <TranscriptRow
                          key={transcript.id}
                          transcript={transcript}
                          idx={idx}
                          isSelected={selectedIndex === idx}
                          onSelect={() => selectItem({ kind: "transcript", transcript })}
                          onHover={() => setSelectedIndex(idx)}
                          t={t}
                        />
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-4 px-3.5 py-2 border-t border-border/30 bg-muted/15">
            <FooterHint keys={["↑", "↓"]} label={t("commandSearch.footer.navigate")} />
            <FooterHint keys={["↵"]} label={t("commandSearch.footer.open")} />
            <FooterHint keys={["Esc"]} label={t("commandSearch.footer.dismiss")} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SectionHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1">
      <span className="text-muted-foreground/45">{icon}</span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/50">
        {label}
      </span>
    </div>
  );
}

function NoteRow({
  note,
  idx,
  isSelected,
  onSelect,
  onHover,
  t,
}: {
  note: NoteItem;
  idx: number;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const preview = stripMarkdownPreview(note.content).slice(0, 90);
  const NoteIcon =
    note.note_type === "meeting" ? Users : note.note_type === "upload" ? Upload : FileText;
  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        "group flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors duration-100 outline-none",
        isSelected
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-foreground/4 dark:hover:bg-white/4"
      )}
    >
      <NoteIcon
        size={13}
        className={cn(
          "shrink-0 mt-px transition-colors",
          isSelected ? "text-primary" : "text-muted-foreground/40"
        )}
      />
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "text-xs font-medium truncate",
            note.title ? "text-foreground" : "italic text-muted-foreground/50"
          )}
        >
          {note.title || t("notes.list.untitled")}
        </p>
        {preview && (
          <p className="text-[11px] text-muted-foreground/55 truncate mt-px">{preview}</p>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground/35 tabular-nums shrink-0">
        {relativeTime(note.updated_at, t)}
      </span>
    </button>
  );
}

function TranscriptRow({
  transcript,
  idx,
  isSelected,
  onSelect,
  onHover,
  t,
}: {
  transcript: TranscriptionItem;
  idx: number;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        "group flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors duration-100 outline-none",
        isSelected
          ? "bg-primary/8 dark:bg-primary/10"
          : "hover:bg-foreground/4 dark:hover:bg-white/4"
      )}
    >
      <Mic
        size={13}
        className={cn(
          "shrink-0 mt-px transition-colors",
          isSelected ? "text-primary" : "text-muted-foreground/40"
        )}
      />
      <p className="flex-1 text-xs text-foreground/75 truncate min-w-0">{transcript.text}</p>
      <span className="text-[10px] text-muted-foreground/35 tabular-nums shrink-0">
        {relativeTime(transcript.created_at, t)}
      </span>
    </button>
  );
}

function FooterHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="text-[10px] px-1 py-px rounded border border-border/40 bg-muted/50 text-muted-foreground/55 font-mono leading-tight"
        >
          {k}
        </kbd>
      ))}
      <span className="text-[10px] text-muted-foreground/40 ml-0.5">{label}</span>
    </div>
  );
}
