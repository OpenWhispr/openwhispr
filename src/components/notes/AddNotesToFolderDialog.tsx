import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Search, FileText, Check } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { formatDateGroup } from "../../utils/dateFormatting";
import type { NoteItem } from "../../types/electron";

interface AddNotesToFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetFolderId: number;
  onNotesAdded: () => void;
}

function groupNotesByDate(notes: NoteItem[], t: (key: string) => string): [string, NoteItem[]][] {
  const groups = new Map<string, NoteItem[]>();
  for (const note of notes) {
    const key = formatDateGroup(note.updated_at, t);
    const arr = groups.get(key) || [];
    arr.push(note);
    groups.set(key, arr);
  }
  return Array.from(groups.entries());
}

export default function AddNotesToFolderDialog({
  open,
  onOpenChange,
  targetFolderId,
  onNotesAdded,
}: AddNotesToFolderDialogProps) {
  const { t } = useTranslation();
  const [allNotes, setAllNotes] = useState<NoteItem[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSelected(new Set());
    window.electronAPI.getNotes(null, 500, null).then(setAllNotes);
  }, [open]);

  const availableNotes = useMemo(
    () => allNotes.filter((n) => n.folder_id !== targetFolderId),
    [allNotes, targetFolderId]
  );

  const filteredNotes = useMemo(() => {
    if (!search.trim()) return availableNotes;
    const q = search.toLowerCase();
    return availableNotes.filter(
      (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
    );
  }, [availableNotes, search]);

  const grouped = useMemo(() => groupNotesByDate(filteredNotes, t), [filteredNotes, t]);

  const toggleNote = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAdd = useCallback(async () => {
    if (selected.size === 0) return;
    setIsAdding(true);
    try {
      await Promise.all(
        Array.from(selected).map((id) =>
          window.electronAPI.updateNote(id, { folder_id: targetFolderId })
        )
      );
      onNotesAdded();
      onOpenChange(false);
    } finally {
      setIsAdding(false);
    }
  }, [selected, targetFolderId, onNotesAdded, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-96 p-0 gap-0 overflow-hidden" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{t("notes.addToFolder.title")}</DialogTitle>

        <div className="px-4 pr-12 pt-4 pb-2">
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground/20"
            />
            <input
              placeholder={t("notes.addToFolder.searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-8 rounded-md bg-foreground/[0.03] dark:bg-white/[0.04] border border-foreground/8 dark:border-white/8 pl-8 pr-3 text-xs text-foreground placeholder:text-foreground/20 outline-none focus:border-primary/30 transition-colors"
              autoFocus
            />
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto px-2 pb-2">
          {grouped.length === 0 ? (
            <div className="flex items-center justify-center py-10">
              <p className="text-xs text-foreground/20">
                {search
                  ? t("notes.addToFolder.noResults")
                  : t("notes.addToFolder.noNotesAvailable")}
              </p>
            </div>
          ) : (
            grouped.map(([dateLabel, notes]) => (
              <div key={dateLabel}>
                <p className="text-xs font-medium text-foreground/30 px-2 pt-3 pb-1.5">
                  {dateLabel}
                </p>
                {notes.map((note) => {
                  const isSelected = selected.has(note.id);
                  return (
                    <button
                      key={note.id}
                      onClick={() => toggleNote(note.id)}
                      className={cn(
                        "w-full flex items-center gap-3 px-2 py-2 rounded-md transition-colors",
                        "hover:bg-foreground/3 dark:hover:bg-white/3",
                        isSelected && "bg-primary/5 dark:bg-primary/8"
                      )}
                    >
                      <div className="w-7 h-7 rounded-md bg-foreground/[0.03] dark:bg-white/[0.04] border border-foreground/6 dark:border-white/6 flex items-center justify-center shrink-0">
                        <FileText size={12} className="text-foreground/20" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="text-xs text-foreground/80 truncate">
                          {note.title || t("notes.list.untitled")}
                        </p>
                      </div>
                      <div
                        className={cn(
                          "w-4 h-4 rounded-[3px] border shrink-0 flex items-center justify-center transition-colors",
                          isSelected
                            ? "bg-primary border-primary"
                            : "border-foreground/15 dark:border-white/15"
                        )}
                      >
                        {isSelected && <Check size={10} className="text-white" strokeWidth={2.5} />}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="px-4 py-3 border-t border-border/30 dark:border-white/5 flex justify-end">
          <Button
            variant="default"
            size="sm"
            onClick={handleAdd}
            disabled={selected.size === 0 || isAdding}
            className="h-7 text-xs"
          >
            {t("notes.addToFolder.addCount", { count: selected.size })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
