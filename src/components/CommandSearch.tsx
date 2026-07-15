import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Search, FileText, Mic, Folder, Lock, Users, Upload, MessageSquare } from "lucide-react";
import { cn } from "./lib/utils";
import type { NoteItem, FolderItem, SpaceItem, TranscriptionItem } from "../types/electron.js";
import { normalizeDbDate } from "../utils/dateFormatting";

interface ConversationResult {
  id: number;
  title: string;
  last_message?: string;
  updated_at: string;
}

interface JumpTarget {
  key: string;
  spaceId: number;
  folderId: number | null;
  label: string;
  space: SpaceItem | undefined;
}

export interface CommandSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: "all" | "conversations";
  transcriptions?: TranscriptionItem[];
  onNoteSelect?: (noteId: number, folderId: number | null, spaceId?: number) => void;
  onContainerSelect?: (spaceId: number, folderId: number | null) => void;
  onTranscriptSelect?: (transcriptId: number) => void;
  onConversationSelect?: (conversationId: number) => void;
}

type FlatItem =
  | { kind: "container"; target: JumpTarget }
  | { kind: "note"; note: NoteItem }
  | { kind: "transcript"; transcript: TranscriptionItem }
  | { kind: "conversation"; conversation: ConversationResult };

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
  mode = "all",
  transcriptions = [],
  onNoteSelect,
  onContainerSelect,
  onTranscriptSelect,
  onConversationSelect,
}: CommandSearchProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [spaces, setSpaces] = useState<SpaceItem[]>([]);
  const [conversations, setConversations] = useState<ConversationResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchVersionRef = useRef(0);
  const isConversationsMode = mode === "conversations";
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevNotes, setPrevNotes] = useState(notes);
  const [prevQuery, setPrevQuery] = useState(query);

  useEffect(() => {
    if (isConversationsMode) return;
    window.electronAPI
      .getFolders()
      .then(setFolders)
      .catch(() => {});
    window.electronAPI
      .getSpaces?.()
      .then((items) => setSpaces(items ?? []))
      .catch(() => {});
  }, [isConversationsMode]);

  if (open && !prevOpen) {
    setPrevOpen(open);
    setQuery("");
    setSelectedIndex(0);
  } else if (open !== prevOpen) {
    setPrevOpen(open);
  }

  useEffect(() => {
    if (!open) return;
    if (isConversationsMode) {
      window.electronAPI?.getAgentConversationsWithPreview?.(20, 0, false).then((r) => {
        if (r)
          setConversations(
            r.map((c) => ({
              id: c.id,
              title: c.title || "Untitled",
              last_message: c.last_message,
              updated_at: c.updated_at,
            }))
          );
      });
    } else {
      window.electronAPI
        .getNotes()
        .then(setNotes)
        .catch(() => {});
    }
  }, [open, isConversationsMode]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const version = ++searchVersionRef.current;

    if (isConversationsMode) {
      if (!query.trim()) {
        window.electronAPI?.getAgentConversationsWithPreview?.(20, 0, false).then((r) => {
          if (searchVersionRef.current === version && r) {
            setConversations(
              r.map((c) => ({
                id: c.id,
                title: c.title || "Untitled",
                last_message: c.last_message,
                updated_at: c.updated_at,
              }))
            );
          }
        });
        return;
      }
      searchTimerRef.current = setTimeout(async () => {
        try {
          const r = await window.electronAPI?.semanticSearchConversations?.(query, 20);
          if (searchVersionRef.current === version && r) {
            setConversations(
              r.map((c) => ({
                id: c.id,
                title: c.title || "Untitled",
                last_message: c.last_message,
                updated_at: c.updated_at,
              }))
            );
          }
        } catch {
          /* keep current */
        }
      }, 200);
    } else {
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
          /* keep current */
        }
      }, 200);
    }

    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query, isConversationsMode]);

  if (notes !== prevNotes || query !== prevQuery) {
    setPrevNotes(notes);
    setPrevQuery(query);
    setSelectedIndex(0);
  }

  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const spaceMap = useMemo(() => new Map(spaces.map((s) => [s.id, s])), [spaces]);

  const spaceLabel = useCallback(
    (space: SpaceItem) =>
      space.kind === "private"
        ? t("notes.spaces.personal")
        : `${space.emoji ? `${space.emoji} ` : ""}${space.name}`,
    [t]
  );

  const noteBreadcrumb = useCallback(
    (note: NoteItem) => {
      const space = spaceMap.get(note.space_id);
      const folder = note.folder_id != null ? folderMap.get(note.folder_id) : undefined;
      if (!space) return folder?.name ?? "";
      return folder ? `${spaceLabel(space)} / ${folder.name}` : spaceLabel(space);
    },
    [spaceMap, folderMap, spaceLabel]
  );

  const jumpTargets = useMemo<JumpTarget[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q || isConversationsMode) return [];
    const targets: JumpTarget[] = [];
    for (const space of spaces) {
      const label = spaceLabel(space);
      if (label.toLowerCase().includes(q)) {
        targets.push({ key: `s:${space.id}`, spaceId: space.id, folderId: null, label, space });
      }
    }
    for (const folder of folders) {
      if (folder.name.toLowerCase().includes(q)) {
        targets.push({
          key: `f:${folder.id}`,
          spaceId: folder.space_id,
          folderId: folder.id,
          label: folder.name,
          space: spaceMap.get(folder.space_id),
        });
      }
    }
    return targets.slice(0, 5);
  }, [query, spaces, folders, spaceMap, spaceLabel, isConversationsMode]);

  const filteredTranscripts = useMemo(() => {
    const slice = query.trim()
      ? transcriptions.filter((tr) => tr.text.toLowerCase().includes(query.toLowerCase()))
      : transcriptions;
    return slice.slice(0, 5);
  }, [transcriptions, query]);

  const flatItems = useMemo<FlatItem[]>(() => {
    if (isConversationsMode) {
      return conversations.map((c) => ({ kind: "conversation" as const, conversation: c }));
    }
    const items: FlatItem[] = [];
    for (const target of jumpTargets) items.push({ kind: "container", target });
    for (const note of notes) items.push({ kind: "note", note });
    for (const transcript of filteredTranscripts) items.push({ kind: "transcript", transcript });
    return items;
  }, [jumpTargets, notes, filteredTranscripts, conversations, isConversationsMode]);

  const selectItem = useCallback(
    (item: FlatItem) => {
      if (item.kind === "container") onContainerSelect?.(item.target.spaceId, item.target.folderId);
      else if (item.kind === "note")
        onNoteSelect?.(item.note.id, item.note.folder_id ?? null, item.note.space_id);
      else if (item.kind === "transcript") onTranscriptSelect?.(item.transcript.id);
      else if (item.kind === "conversation") onConversationSelect?.(item.conversation.id);
      onOpenChange(false);
    },
    [onNoteSelect, onContainerSelect, onTranscriptSelect, onConversationSelect, onOpenChange]
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
              placeholder={isConversationsMode ? t("chat.search") : t("commandSearch.placeholder")}
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
                  {query.trim()
                    ? t("commandSearch.noResults")
                    : isConversationsMode
                      ? t("chat.noConversations")
                      : t("commandSearch.emptyState")}
                </p>
              </div>
            ) : isConversationsMode ? (
              conversations.map((conv, idx) => (
                <button
                  key={conv.id}
                  type="button"
                  data-idx={idx}
                  onClick={() => selectItem({ kind: "conversation", conversation: conv })}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={cn(
                    "flex items-center gap-2.5 w-full px-2.5 py-2 rounded-lg text-left transition-colors duration-100 outline-none",
                    selectedIndex === idx
                      ? "bg-primary/8 dark:bg-primary/10"
                      : "hover:bg-foreground/4 dark:hover:bg-white/4"
                  )}
                >
                  <MessageSquare
                    size={13}
                    className={cn(
                      "shrink-0 mt-px transition-colors",
                      selectedIndex === idx ? "text-primary" : "text-muted-foreground/40"
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{conv.title}</p>
                    {conv.last_message && (
                      <p className="text-[11px] text-muted-foreground/55 truncate mt-px">
                        {conv.last_message.slice(0, 90)}
                      </p>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground/35 tabular-nums shrink-0">
                    {relativeTime(conv.updated_at, t)}
                  </span>
                </button>
              ))
            ) : (
              <>
                {jumpTargets.length > 0 && (
                  <div>
                    <SectionHeader
                      icon={<Folder size={11} />}
                      label={t("commandSearch.sections.jumpTo")}
                    />
                    {jumpTargets.map((target) => {
                      const idx = flatItems.findIndex(
                        (fi) => fi.kind === "container" && fi.target.key === target.key
                      );
                      return (
                        <ContainerRow
                          key={target.key}
                          target={target}
                          showSpaceHint={target.folderId != null && spaces.length > 1}
                          spaceLabel={spaceLabel}
                          idx={idx}
                          isSelected={selectedIndex === idx}
                          onSelect={() => selectItem({ kind: "container", target })}
                          onHover={() => setSelectedIndex(idx)}
                        />
                      );
                    })}
                  </div>
                )}

                {notes.length > 0 && (
                  <div className={jumpTargets.length > 0 ? "mt-0.5" : ""}>
                    <SectionHeader
                      icon={<FileText size={11} />}
                      label={t("commandSearch.sections.notes")}
                    />
                    {notes.map((note) => {
                      const idx = flatItems.findIndex(
                        (fi) => fi.kind === "note" && fi.note.id === note.id
                      );
                      return (
                        <NoteRow
                          key={note.id}
                          note={note}
                          breadcrumb={noteBreadcrumb(note)}
                          idx={idx}
                          isSelected={selectedIndex === idx}
                          onSelect={() => selectItem({ kind: "note", note })}
                          onHover={() => setSelectedIndex(idx)}
                          t={t}
                        />
                      );
                    })}
                  </div>
                )}

                {filteredTranscripts.length > 0 && (
                  <div className={jumpTargets.length > 0 || notes.length > 0 ? "mt-0.5" : ""}>
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

function ContainerRow({
  target,
  showSpaceHint,
  spaceLabel,
  idx,
  isSelected,
  onSelect,
  onHover,
}: {
  target: JumpTarget;
  showSpaceHint: boolean;
  spaceLabel: (space: SpaceItem) => string;
  idx: number;
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const { space } = target;
  const iconClass = cn(
    "shrink-0 transition-colors",
    isSelected ? "text-primary" : "text-muted-foreground/40"
  );
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
      {target.folderId != null ? (
        <Folder size={13} className={iconClass} />
      ) : space?.kind === "private" ? (
        <Lock size={13} className={iconClass} />
      ) : space?.emoji ? (
        <span className="text-[13px] leading-none shrink-0" aria-hidden="true">
          {space.emoji}
        </span>
      ) : (
        <Users size={13} className={iconClass} />
      )}
      <p className="flex-1 text-xs font-medium text-foreground truncate min-w-0">{target.label}</p>
      {showSpaceHint && space && (
        <span className="text-[10px] text-muted-foreground/45 truncate shrink-0 max-w-32">
          {spaceLabel(space)}
        </span>
      )}
    </button>
  );
}

function NoteRow({
  note,
  breadcrumb,
  idx,
  isSelected,
  onSelect,
  onHover,
  t,
}: {
  note: NoteItem;
  breadcrumb: string;
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
        {(breadcrumb || preview) && (
          <p className="text-[10px] truncate mt-px">
            {breadcrumb && <span className="text-muted-foreground/45">{breadcrumb}</span>}
            {breadcrumb && preview && <span className="text-muted-foreground/35"> · </span>}
            {preview && <span className="text-muted-foreground/55">{preview}</span>}
          </p>
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
