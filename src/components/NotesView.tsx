import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, StickyNote, Plus } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "./lib/utils";
import type { NoteItem } from "../types/electron.js";
import { formatDateGroup } from "../utils/dateFormatting";
import { normalizeDbDate } from "../utils/dateFormatting";

const NOTE_TYPE_COLORS: Record<NoteItem["note_type"], string> = {
  personal: "bg-foreground/5 text-foreground/50",
  meeting: "bg-blue-500/8 text-blue-500/60 dark:bg-blue-400/10 dark:text-blue-400/60",
  upload: "bg-amber-500/8 text-amber-600/60 dark:bg-amber-400/10 dark:text-amber-400/60",
};

function relativeTime(
  dateStr: string,
  t: (key: string, opts?: Record<string, unknown>) => string
): string {
  const date = normalizeDbDate(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
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

const RE_HEADING = /#{1,6}\s+/g;
const RE_EMPHASIS = /[*_~`]+/g;
const RE_LINK = /\[([^\]]+)\]\([^)]+\)/g;
const RE_IMAGE = /!\[([^\]]*)\]\([^)]+\)/g;
const RE_BLOCKQUOTE = />\s+/g;
const RE_NEWLINES = /\n+/g;

function stripMarkdown(text: string): string {
  return text
    .replace(RE_HEADING, "")
    .replace(RE_EMPHASIS, "")
    .replace(RE_LINK, "$1")
    .replace(RE_IMAGE, "$1")
    .replace(RE_BLOCKQUOTE, "")
    .replace(RE_NEWLINES, " ")
    .trim();
}

export interface NotesViewProps {
  notes: NoteItem[];
  isLoading: boolean;
  activeNoteId: number | null;
  onNoteSelect: (id: number) => void;
  onNewNote: () => void;
  cloudEnabled: boolean;
}

export default function NotesView({
  notes,
  isLoading,
  activeNoteId,
  onNoteSelect,
  onNewNote,
  cloudEnabled,
}: NotesViewProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [displayedNotes, setDisplayedNotes] = useState<NoteItem[]>(notes);
  const cloudTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!query.trim()) setDisplayedNotes(notes);
  }, [notes, query]);

  const handleSearch = useCallback(
    async (value: string) => {
      if (cloudTimerRef.current) clearTimeout(cloudTimerRef.current);

      if (!value.trim()) {
        setDisplayedNotes(notes);
        return;
      }

      const localResults = await window.electronAPI.searchNotes(value).catch(() => notes);
      setDisplayedNotes(localResults);

      if (!cloudEnabled) return;

      cloudTimerRef.current = setTimeout(async () => {
        try {
          const { NotesService } = await import("../services/NotesService.js");
          const { notes: cloudNotes } = await NotesService.search(value);
          const byClientId = new Map(notes.map((n) => [String(n.id), n]));
          const mapped = cloudNotes
            .map((cn) => byClientId.get(cn.client_note_id ?? ""))
            .filter((n): n is NoteItem => n !== undefined);
          if (mapped.length > 0) setDisplayedNotes(mapped);
        } catch {
          // keep local results silently
        }
      }, 300);
    },
    [notes, cloudEnabled]
  );

  useEffect(() => {
    handleSearch(query);
    return () => {
      if (cloudTimerRef.current) clearTimeout(cloudTimerRef.current);
    };
  }, [query, handleSearch]);

  const groupedNotes = useMemo(() => {
    if (displayedNotes.length === 0) return [];

    const groups: { label: string; items: NoteItem[] }[] = [];
    let currentLabel: string | null = null;

    for (const note of displayedNotes) {
      const label = formatDateGroup(note.updated_at, t);
      if (label !== currentLabel) {
        groups.push({ label, items: [note] });
        currentLabel = label;
      } else {
        groups[groups.length - 1].items.push(note);
      }
    }

    return groups;
  }, [displayedNotes, t]);

  return (
    <div className="px-4 pt-4 pb-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("notesView.searchPlaceholder")}
            className="h-8 text-xs bg-card/50 dark:bg-card/60 border-border/50"
          />
          <Button size="sm" className="h-8 text-xs shrink-0 gap-1.5" onClick={onNewNote}>
            <Plus size={13} />
            {t("notesView.newNote")}
          </Button>
        </div>

        {isLoading ? (
          <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm">
            <div className="flex items-center justify-center gap-2 py-8">
              <Loader2 size={14} className="animate-spin text-primary" />
              <span className="text-sm text-muted-foreground">{t("controlPanel.loading")}</span>
            </div>
          </div>
        ) : query.trim() && displayedNotes.length === 0 ? (
          <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm">
            <div className="flex flex-col items-center justify-center py-16 px-4">
              <h3 className="text-xs font-semibold text-foreground/70 dark:text-foreground/60 mb-1">
                {t("notesView.searchEmpty.title")}
              </h3>
              <p className="text-xs text-foreground/50 dark:text-foreground/25">
                {t("notesView.searchEmpty.description", { query })}
              </p>
            </div>
          </div>
        ) : displayedNotes.length === 0 ? (
          <div className="rounded-lg border border-border bg-card/50 dark:bg-card/60 backdrop-blur-sm">
            <div className="flex flex-col items-center justify-center py-16 px-4">
              <StickyNote
                size={40}
                className="text-foreground/10 dark:text-foreground/8 mb-4"
                strokeWidth={1.25}
              />
              <h3 className="text-xs font-semibold text-foreground/70 dark:text-foreground/60 mb-1">
                {t("notesView.empty.title")}
              </h3>
              <p className="text-xs text-foreground/50 dark:text-foreground/25 mb-4">
                {t("notesView.empty.description")}
              </p>
              <Button size="sm" className="h-7 text-xs gap-1.5" onClick={onNewNote}>
                <Plus size={12} />
                {t("notesView.newNote")}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            {groupedNotes.map((group, index) => (
              <div key={group.label} className={index > 0 ? "mt-4" : ""}>
                <div className="sticky -top-1 z-10 -mx-4 px-5 pt-2 pb-2 bg-background">
                  <span className="text-[11px] font-semibold text-muted-foreground dark:text-muted-foreground uppercase tracking-wide">
                    {group.label}
                  </span>
                </div>
                <div className="space-y-1.5 relative z-0">
                  {group.items.map((note) => {
                    const isActive = note.id === activeNoteId;
                    const preview = stripMarkdown(note.content).slice(0, 120);

                    return (
                      <button
                        key={note.id}
                        type="button"
                        onClick={() => onNoteSelect(note.id)}
                        className={cn(
                          "group w-full text-left rounded-lg border px-4 py-3 transition-all duration-150",
                          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
                          isActive
                            ? "border-primary/20 bg-primary/5 dark:bg-primary/8"
                            : "border-border/50 bg-card/50 dark:bg-card/60 hover:border-border hover:bg-card dark:hover:bg-card/80"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p
                            className={cn(
                              "text-xs font-medium truncate text-foreground",
                              !note.title && "italic text-foreground/40"
                            )}
                          >
                            {note.title || t("notes.list.untitled")}
                          </p>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span
                              className={cn(
                                "text-[10px] font-medium px-1.5 py-px rounded-sm",
                                NOTE_TYPE_COLORS[note.note_type]
                              )}
                            >
                              {t(`notesView.noteType.${note.note_type}`)}
                            </span>
                            <span className="text-xs text-muted-foreground/60 dark:text-muted-foreground/30 tabular-nums">
                              {relativeTime(note.updated_at, t)}
                            </span>
                          </div>
                        </div>
                        {preview && (
                          <p className="text-xs text-muted-foreground/70 dark:text-muted-foreground/35 mt-0.5 line-clamp-1">
                            {preview}
                          </p>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
