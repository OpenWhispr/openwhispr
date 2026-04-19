import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog.js";
import { cn } from "./lib/utils";
import type { NoteItem } from "../types/electron.js";
import { syncService } from "../services/SyncService.js";

const NOTE_TYPE_COLORS: Record<NoteItem["note_type"], string> = {
  personal: "bg-foreground/5 text-foreground/50",
  meeting: "bg-blue-500/8 text-blue-500/60 dark:bg-blue-400/10 dark:text-blue-400/60",
  upload: "bg-amber-500/8 text-amber-600/60 dark:bg-amber-400/10 dark:text-amber-400/60",
};

type SaveState = "idle" | "saving" | "saved";

interface NoteEditorProps {
  note: NoteItem;
  cloudEnabled: boolean;
  onDelete: (id: number) => void;
  onUpdate: (note: NoteItem) => void;
}

export default function NoteEditor({ note, cloudEnabled, onDelete, onUpdate }: NoteEditorProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [prevNoteId, setPrevNoteId] = useState(note.id);

  if (note.id !== prevNoteId) {
    setPrevNoteId(note.id);
    setTitle(note.title);
    setContent(note.content);
    setSaveState("idle");
  }

  const autoResize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);

  useEffect(() => {
    autoResize();
  }, [content, autoResize]);

  const scheduleAutoSave = useCallback(
    (updatedTitle: string, updatedContent: string) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);

      saveTimerRef.current = setTimeout(async () => {
        setSaveState("saving");
        const updates = { title: updatedTitle, content: updatedContent };
        try {
          await window.electronAPI.updateNote(note.id, updates);
          const updated = { ...note, ...updates };
          onUpdate(updated);
          syncService.debouncedPush("note", note.id);
          setSaveState("saved");
          fadeTimerRef.current = setTimeout(() => setSaveState("idle"), 2000);
        } catch {
          setSaveState("idle");
        }
      }, 800);
    },
    [note, onUpdate]
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, []);

  const handleTitleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = e.target.value;
      setTitle(next);
      scheduleAutoSave(next, content);
    },
    [content, scheduleAutoSave]
  );

  const handleContentChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setContent(next);
      autoResize();
      scheduleAutoSave(title, next);
    },
    [title, scheduleAutoSave, autoResize]
  );

  const handleConfirmDelete = useCallback(async () => {
    await window.electronAPI.deleteNote(note.id);
    onDelete(note.id);
  }, [note, onDelete]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-5 pt-4 pb-2 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              "shrink-0 text-[10px] font-medium px-1.5 py-px rounded-sm",
              NOTE_TYPE_COLORS[note.note_type]
            )}
          >
            {t(`notesView.noteType.${note.note_type}`)}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span
            className={cn(
              "text-xs text-muted-foreground/50 transition-opacity duration-300",
              saveState === "idle" && "opacity-0",
              saveState === "saving" && "opacity-100",
              saveState === "saved" && "opacity-100"
            )}
          >
            {saveState === "saving" ? (
              <span className="flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                {t("notes.editor.saving")}
              </span>
            ) : (
              t("noteEditor.saved")
            )}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground/50 hover:text-destructive hover:bg-destructive/8"
            onClick={() => setConfirmOpen(true)}
            aria-label={t("noteEditor.deleteNote")}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      </div>

      <div className="px-5 pb-2">
        <input
          type="text"
          value={title}
          onChange={handleTitleChange}
          placeholder={t("notes.editor.untitled")}
          className="w-full bg-transparent outline-none border-none text-lg font-medium text-foreground placeholder:text-foreground/20 tracking-[-0.01em]"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6 min-h-0">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleContentChange}
          placeholder={t("notes.editor.startWriting")}
          rows={1}
          className="w-full bg-transparent outline-none border-none resize-none text-sm text-foreground/80 placeholder:text-foreground/20 leading-relaxed"
        />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("noteEditor.deleteConfirmTitle")}
        description={t("noteEditor.deleteConfirmDescription")}
        confirmText={t("noteEditor.deleteConfirm")}
        cancelText={t("common.cancel")}
        onConfirm={handleConfirmDelete}
        variant="destructive"
      />
    </div>
  );
}
