import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Trash2, Loader2, Plus, Zap } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { cn } from "../lib/utils";
import { useActions, initializeActions, getActionName } from "../../stores/actionStore";
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setName("");
    setDescription("");
    setPrompt("");
    setEditingId(null);
  };

  useEffect(() => {
    if (open) {
      initializeActions();
      setIsCreating(false);
      setEditingId(null);
      setSelectedId(null);
      resetForm();
    }
  }, [open]);

  // Auto-select the first action when actions load and nothing is selected
  useEffect(() => {
    if (open && actions.length > 0 && selectedId === null && !isCreating) {
      const first = actions[0];
      setSelectedId(first.id);
      setEditingId(first.id);
      setName(first.name);
      setDescription(first.description);
      setPrompt(first.prompt);
    }
  }, [open, actions, selectedId, isCreating]);

  const handleSelectAction = (action: ActionItem) => {
    setSelectedId(action.id);
    setEditingId(action.id);
    setName(action.name);
    setDescription(action.description);
    setPrompt(action.prompt);
    setIsCreating(false);
  };

  const handleNewAction = () => {
    resetForm();
    setSelectedId(null);
    setIsCreating(true);
    // Focus name input after state update
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  const handleDelete = async (id: number) => {
    await window.electronAPI.deleteAction(id);
    if (selectedId === id) {
      setSelectedId(null);
      setIsCreating(false);
      resetForm();
    }
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
        setIsCreating(false);
      }
    } finally {
      setIsSaving(false);
    }
  };

  const showEditor = isCreating || selectedId !== null;
  const selectedAction = actions.find((a) => a.id === selectedId);
  const hasUnsavedChanges = isCreating
    ? name.trim() !== "" || prompt.trim() !== ""
    : selectedAction
      ? name !== selectedAction.name ||
        description !== selectedAction.description ||
        prompt !== selectedAction.prompt
      : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl p-0 gap-0 overflow-hidden">
        {/* Hidden accessible title */}
        <DialogTitle className="sr-only">{t("notes.actions.manageTitle")}</DialogTitle>

        <div className="flex h-120">
          {/* Left panel — action list */}
          <div className="w-56 shrink-0 border-r border-border/15 dark:border-white/4 flex flex-col bg-card/50 dark:bg-surface-1/30">
            {/* List header */}
            <div className="flex items-center justify-between px-3 pt-3.5 pb-2">
              <span className="text-xs font-semibold tracking-tight text-foreground/70">
                {t("notes.actions.manageTitle")}
              </span>
              <button
                onClick={handleNewAction}
                className={cn(
                  "p-1 rounded-md",
                  "text-muted-foreground/50 hover:text-foreground/70",
                  "hover:bg-foreground/5 dark:hover:bg-white/6",
                  "active:bg-foreground/8 dark:active:bg-white/8",
                  "transition-colors duration-150"
                )}
                aria-label={t("notes.actions.addAction")}
              >
                <Plus size={13} />
              </button>
            </div>

            {/* Action list */}
            <div className="flex-1 overflow-y-auto px-1.5 pb-2">
              {actions.length === 0 && !isCreating ? (
                <div className="flex flex-col items-center justify-center h-full px-4 text-center">
                  <Zap size={20} className="text-muted-foreground/20 mb-2" />
                  <p className="text-xs text-muted-foreground/40 leading-relaxed">
                    {t("notes.actions.noActions")}
                  </p>
                  <button
                    onClick={handleNewAction}
                    className="text-xs text-accent/60 hover:text-accent/80 mt-2 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 rounded"
                  >
                    {t("notes.actions.addAction")}
                  </button>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {actions.map((action) => (
                    <div
                      key={action.id}
                      onClick={() => handleSelectAction(action)}
                      className={cn(
                        "flex items-center gap-2 w-full px-2.5 py-2 rounded-md text-left group cursor-pointer",
                        "transition-colors duration-150",
                        selectedId === action.id && !isCreating
                          ? "bg-accent/8 dark:bg-accent/10"
                          : "hover:bg-foreground/3 dark:hover:bg-white/3"
                      )}
                    >
                      <Sparkles
                        size={12}
                        className={cn(
                          "shrink-0 transition-colors duration-150",
                          selectedId === action.id && !isCreating
                            ? "text-accent/60"
                            : "text-muted-foreground/30"
                        )}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "text-xs font-medium truncate",
                              selectedId === action.id && !isCreating
                                ? "text-foreground"
                                : "text-foreground/70"
                            )}
                          >
                            {getActionName(action, t)}
                          </span>
                          {action.is_builtin === 1 && (
                            <span className="text-[10px] font-medium px-1 py-px rounded bg-foreground/5 dark:bg-white/6 text-muted-foreground/40 shrink-0">
                              {t("notes.actions.builtIn")}
                            </span>
                          )}
                        </div>
                      </div>
                      {action.is_builtin !== 1 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(action.id);
                          }}
                          aria-label={t("notes.context.delete")}
                          className={cn(
                            "p-1 rounded-md shrink-0",
                            "text-muted-foreground/0 group-hover:text-muted-foreground/30",
                            "hover:text-destructive/60! hover:bg-destructive/5",
                            "active:bg-destructive/8",
                            "transition-all duration-150"
                          )}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right panel — editor */}
          <div className="flex-1 flex flex-col min-w-0">
            {showEditor ? (
              <>
                {/* Editor header — pr-12 clears the dialog close X button */}
                <div className="flex items-center justify-between pl-5 pr-12 pt-4 pb-3 border-b border-border/10 dark:border-white/3">
                  <span className="text-xs font-medium text-muted-foreground/50">
                    {isCreating ? t("notes.actions.addAction") : t("notes.actions.editAction")}
                  </span>
                  <div className="flex items-center gap-2">
                    {isCreating && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setIsCreating(false);
                          resetForm();
                          // Re-select first action if available
                          if (actions.length > 0) handleSelectAction(actions[0]);
                        }}
                        disabled={isSaving}
                        className="h-7 text-xs"
                      >
                        {t("notes.actions.cancel")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={handleSave}
                      disabled={isSaving || !name.trim() || !prompt.trim() || !hasUnsavedChanges}
                      className="h-7 text-xs"
                    >
                      {isSaving ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : isCreating ? (
                        t("notes.actions.save")
                      ) : (
                        t("notes.actions.update")
                      )}
                    </Button>
                  </div>
                </div>

                {/* Editor form */}
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                  <Input
                    ref={nameInputRef}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("notes.actions.namePlaceholder")}
                    disabled={isSaving}
                    className="h-9"
                  />
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t("notes.actions.descriptionPlaceholder")}
                    disabled={isSaving}
                    className="h-9"
                  />

                  {/* Prompt — the star of the show */}
                  <div className="flex flex-col flex-1 space-y-1.5 min-h-0">
                    <label className="text-xs font-medium text-foreground/50">
                      {t("notes.actions.promptLabel", { defaultValue: "Prompt" })}
                    </label>
                    <textarea
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={t("notes.actions.promptPlaceholder")}
                      disabled={isSaving}
                      className={cn(
                        "flex-1 min-h-50 w-full rounded border border-border/70 bg-input px-3.5 py-3 text-sm text-foreground leading-relaxed transition-colors duration-200 outline-none resize-none",
                        "placeholder:text-muted-foreground/40",
                        "hover:border-border-hover",
                        "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/10",
                        "dark:bg-surface-1 dark:border-border-subtle/50",
                        "dark:focus-visible:border-border-active dark:focus-visible:ring-ring/10",
                        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted",
                        "font-mono text-[13px]"
                      )}
                    />
                  </div>
                </div>
              </>
            ) : (
              /* Empty state — no action selected */
              <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
                <div className="w-10 h-10 rounded-xl bg-accent/5 dark:bg-accent/8 flex items-center justify-center mb-3">
                  <Sparkles size={18} className="text-accent/30" />
                </div>
                <p className="text-sm font-medium text-foreground/40 mb-1">
                  {t("notes.actions.emptyEditorTitle", { defaultValue: "Select an action" })}
                </p>
                <p className="text-xs text-muted-foreground/30 mb-4 max-w-52 leading-relaxed">
                  {t("notes.actions.emptyEditorDescription", {
                    defaultValue: "Choose an action from the list or create a new one",
                  })}
                </p>
                <Button
                  variant="outline-flat"
                  size="sm"
                  onClick={handleNewAction}
                  className="h-7 text-xs gap-1.5"
                >
                  <Plus size={12} />
                  {t("notes.actions.addAction")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
