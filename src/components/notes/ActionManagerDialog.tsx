import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Pencil, Trash2, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import {
  useActions,
  initializeActions,
  getActionName,
  getActionDescription,
} from "../../stores/actionStore";
import { notesInputClass, notesTextareaClass } from "./shared";
import type { ActionItem } from "../../types/electron";

interface ActionManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ActionManagerDialog({ open, onOpenChange }: ActionManagerDialogProps) {
  const { t } = useTranslation();
  const actions = useActions();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      initializeActions();
    } else {
      resetForm();
    }
  }, [open]);

  const resetForm = () => {
    setName("");
    setDescription("");
    setPrompt("");
    setEditingId(null);
  };

  const handleEdit = (action: ActionItem) => {
    setName(action.name);
    setDescription(action.description);
    setPrompt(action.prompt);
    setEditingId(action.id);
  };

  const handleDelete = async (id: number) => {
    await window.electronAPI.deleteAction(id);
    if (editingId === id) resetForm();
  };

  const handleSave = async () => {
    if (!name.trim() || !prompt.trim()) return;
    setIsSaving(true);
    try {
      if (editingId !== null) {
        await window.electronAPI.updateAction(editingId, {
          name: name.trim(),
          description: description.trim(),
          prompt: prompt.trim(),
        });
      } else {
        await window.electronAPI.createAction(name.trim(), description.trim(), prompt.trim());
      }
      resetForm();
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg gap-2.5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Sparkles size={13} className="text-accent" />
            {t("notes.actions.manageTitle")}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground/50">
            {editingId !== null ? t("notes.actions.editAction") : t("notes.actions.addAction")}
          </p>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("notes.actions.namePlaceholder")}
            disabled={isSaving}
            className={cn(notesInputClass, "disabled:opacity-40")}
          />
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("notes.actions.descriptionPlaceholder")}
            disabled={isSaving}
            className={cn(notesInputClass, "disabled:opacity-40")}
          />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("notes.actions.promptPlaceholder")}
            rows={3}
            disabled={isSaving}
            className={cn(notesTextareaClass, "disabled:opacity-40")}
          />
          <div className="flex items-center justify-end gap-2">
            {editingId !== null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={resetForm}
                disabled={isSaving}
                className="h-7 text-xs"
              >
                {t("notes.actions.cancel")}
              </Button>
            )}
            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={isSaving || !name.trim() || !prompt.trim()}
              className="h-7 text-xs"
            >
              {isSaving ? (
                <Loader2 size={12} className="animate-spin" />
              ) : editingId !== null ? (
                t("notes.actions.update")
              ) : (
                t("notes.actions.save")
              )}
            </Button>
          </div>
        </div>

        <div className="border-t border-border/20 dark:border-white/4 pt-2.5">
          {actions.length === 0 ? (
            <p className="text-xs text-muted-foreground/40 text-center py-4">
              {t("notes.actions.noActions")}
            </p>
          ) : (
            <div className="space-y-0.5 max-h-52 overflow-y-auto">
              {actions.map((action) => (
                <div
                  key={action.id}
                  className={cn(
                    "flex items-center gap-2.5 px-2.5 py-2 rounded-md group",
                    "hover:bg-foreground/3 dark:hover:bg-white/3",
                    "transition-colors duration-150"
                  )}
                >
                  <Sparkles size={12} className="text-accent/40 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium truncate">
                        {getActionName(action, t)}
                      </span>
                      {action.is_builtin === 1 && (
                        <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-foreground/5 dark:bg-white/6 text-muted-foreground/50 shrink-0">
                          {t("notes.actions.builtIn")}
                        </span>
                      )}
                    </div>
                    {action.description && (
                      <p className="text-xs text-muted-foreground/40 truncate">
                        {getActionDescription(action, t)}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-150 shrink-0">
                    <button
                      onClick={() => handleEdit(action)}
                      aria-label={t("notes.actions.editAction")}
                      className={cn(
                        "p-1.5 rounded-md",
                        "text-muted-foreground/40 hover:text-foreground/70",
                        "hover:bg-foreground/5 dark:hover:bg-white/6",
                        "active:bg-foreground/8 dark:active:bg-white/8",
                        "transition-colors duration-150"
                      )}
                    >
                      <Pencil size={11} />
                    </button>
                    {action.is_builtin !== 1 && (
                      <button
                        onClick={() => handleDelete(action.id)}
                        aria-label={t("notes.context.delete")}
                        className={cn(
                          "p-1.5 rounded-md",
                          "text-muted-foreground/40 hover:text-destructive/70",
                          "hover:bg-destructive/5 active:bg-destructive/8",
                          "transition-colors duration-150"
                        )}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
