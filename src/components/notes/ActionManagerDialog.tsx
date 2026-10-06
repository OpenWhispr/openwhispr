import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Trash2, Loader2, Plus, Zap, ChevronUp, ChevronDown, X } from "../icons";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import { useToast } from "../ui/useToast";
import { cn } from "../lib/utils";
import { useActionsOfKind, initializeActions, getActionName } from "../../stores/actionStore";
import { NOTE_ACTION_LIMITS } from "../../helpers/builtinActions";
import { normalizeSections } from "../../helpers/templatePrompts";
import type { ActionItem, ActionKind, ActionOutput, TemplateSection } from "../../types/electron";

interface ActionManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialKind: ActionKind;
  /** Picks chat or summary for an action saved with Auto. */
  onInferOutput: (prompt: string) => Promise<ActionOutput>;
}

// Rows keep a stable key while sections are reordered or removed.
type SectionDraft = TemplateSection & { key: string };

const toDrafts = (sections: TemplateSection[] | null): SectionDraft[] =>
  (sections ?? []).map((section) => ({ ...section, key: crypto.randomUUID() }));

const TEXTAREA_CLASS = cn(
  "w-full rounded border border-border/70 bg-input px-3.5 py-3 text-sm text-foreground leading-relaxed transition-colors duration-200 outline-none resize-none",
  "placeholder:text-muted-foreground/70",
  "hover:border-border-hover",
  "focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/10",
  "dark:bg-surface-1 dark:border-border-subtle/60",
  "dark:focus-visible:border-border-active dark:focus-visible:ring-ring/10",
  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted",
  "font-mono text-[13px]"
);

const OUTPUT_HINT_KEYS = {
  auto: "notes.actions.output.autoHint",
  chat: "notes.actions.output.chatHint",
  summary: "notes.actions.output.summaryHint",
} as const;

const ICON_BUTTON_CLASS =
  "p-1 rounded-md text-muted-foreground/70 hover:text-foreground/70 hover:bg-foreground/5 dark:hover:bg-white/6 transition-colors duration-150 disabled:opacity-30 disabled:pointer-events-none";

export default function ActionManagerDialog({
  open,
  onOpenChange,
  initialKind,
  onInferOutput,
}: ActionManagerDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [kind, setKind] = useState<ActionKind>(initialKind);
  const items = useActionsOfKind(kind);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sections, setSections] = useState<SectionDraft[]>([]);
  const [output, setOutput] = useState<ActionOutput | "auto">("auto");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const isTemplate = kind === "template";

  const resetForm = () => {
    setName("");
    setDescription("");
    setPrompt("");
    setSections([]);
    setOutput("auto");
    setEditingId(null);
  };

  const showKind = (next: ActionKind) => {
    setKind(next);
    setIsCreating(false);
    setSelectedId(null);
    resetForm();
  };

  useEffect(() => {
    if (open) {
      initializeActions();
      setKind(initialKind);
      setIsCreating(false);
      setSelectedId(null);
      resetForm();
    }
  }, [open, initialKind]);

  const handleSelectAction = (action: ActionItem) => {
    setSelectedId(action.id);
    setEditingId(action.id);
    setName(action.name);
    setDescription(action.description);
    setPrompt(action.prompt);
    setSections(toDrafts(action.sections));
    setOutput(action.output ?? "chat");
    setIsCreating(false);
  };

  // Auto-select the first item when the list loads and nothing is selected
  useEffect(() => {
    if (open && items.length > 0 && selectedId === null && !isCreating) {
      handleSelectAction(items[0]);
    }
  }, [open, items, selectedId, isCreating]);

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

  const updateSection = (key: string, patch: Partial<TemplateSection>) =>
    setSections((current) => current.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const moveSection = (index: number, offset: number) =>
    setSections((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });

  const savedSections: TemplateSection[] = normalizeSections(sections);
  // A section without a heading isn't saved, so its instruction would be lost.
  const hasHeadlessInstruction = sections.some(
    (section) => section.instruction.trim() && normalizeSections([section]).length === 0
  );
  const canSave =
    !!name.trim() &&
    !hasHeadlessInstruction &&
    (isTemplate ? !!prompt.trim() || savedSections.length > 0 : !!prompt.trim());

  const handleSave = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      const fields = isTemplate
        ? { sections: savedSections }
        : { output: output === "auto" ? await onInferOutput(prompt.trim()) : output };
      const result =
        editingId !== null
          ? await window.electronAPI.updateAction(editingId, {
              name: name.trim(),
              description: description.trim(),
              prompt: prompt.trim(),
              ...fields,
            })
          : await window.electronAPI.createAction(
              name.trim(),
              description.trim(),
              prompt.trim(),
              undefined,
              { kind, ...fields }
            );
      if (!result.success) {
        toast({ title: t("notes.actions.errors.saveFailed"), variant: "destructive" });
        return;
      }
      if (editingId === null) setIsCreating(false);
    } finally {
      setIsSaving(false);
    }
  };

  const showEditor = isCreating || selectedId !== null;
  const selectedAction = items.find((a) => a.id === selectedId);
  const hasUnsavedChanges = isCreating
    ? name.trim() !== "" || prompt.trim() !== "" || savedSections.length > 0
    : selectedAction
      ? name !== selectedAction.name ||
        description !== selectedAction.description ||
        prompt !== selectedAction.prompt ||
        JSON.stringify(savedSections) !== JSON.stringify(selectedAction.sections ?? []) ||
        (!isTemplate && output !== selectedAction.output)
      : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl p-0 gap-0 overflow-hidden">
        {/* Hidden accessible title */}
        <DialogTitle className="sr-only">{t("notes.templates.managerTitle")}</DialogTitle>

        <div className="flex h-120">
          {/* Left panel — template/action list */}
          <div
            // Auto can take a moment on save; switching away then would drop the new draft.
            inert={isSaving}
            className={cn(
              "w-56 shrink-0 border-e border-border dark:border-white/10 flex flex-col bg-card/50 dark:bg-surface-1/30",
              isSaving && "opacity-60"
            )}
          >
            {/* List header */}
            <div className="flex items-center gap-1.5 px-3 pt-3.5 pb-2">
              <Tabs
                value={kind}
                onValueChange={(value) => showKind(value as ActionKind)}
                className="flex-1 min-w-0"
              >
                <TabsList className="h-7 w-full p-0.5">
                  <TabsTrigger value="template" className="flex-1 px-2 py-0.5 text-xs">
                    {t("notes.templates.tab")}
                  </TabsTrigger>
                  <TabsTrigger value="action" className="flex-1 px-2 py-0.5 text-xs">
                    {t("notes.actions.tab")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
              <button
                onClick={handleNewAction}
                className={cn(
                  "p-1 rounded-md",
                  "text-muted-foreground/70 hover:text-foreground/70",
                  "hover:bg-foreground/5 dark:hover:bg-white/6",
                  "active:bg-foreground/8 dark:active:bg-white/8",
                  "transition-colors duration-150"
                )}
                aria-label={t(
                  isTemplate ? "notes.templates.addTemplate" : "notes.actions.addAction"
                )}
              >
                <Plus size={13} />
              </button>
            </div>

            {/* Template/action list */}
            <div className="flex-1 overflow-y-auto px-1.5 pb-2">
              {items.length === 0 && !isCreating ? (
                <div className="flex flex-col items-center justify-center h-full px-4 text-center">
                  <Zap size={20} className="text-muted-foreground/70 mb-2" />
                  <p className="text-xs text-muted-foreground/70 leading-relaxed">
                    {t(isTemplate ? "notes.templates.noTemplates" : "notes.actions.noActions")}
                  </p>
                  <button
                    onClick={handleNewAction}
                    className="text-xs text-accent/60 hover:text-accent/80 mt-2 transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 rounded"
                  >
                    {t(isTemplate ? "notes.templates.addTemplate" : "notes.actions.addAction")}
                  </button>
                </div>
              ) : (
                <div className="space-y-0.5">
                  {items.map((action) => (
                    <div
                      key={action.id}
                      onClick={() => handleSelectAction(action)}
                      className={cn(
                        "flex items-center gap-2 w-full px-2.5 py-2 rounded-md text-start group cursor-pointer",
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
                            : "text-muted-foreground/70"
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
                            <span className="text-[10px] font-medium px-1 py-px rounded bg-foreground/5 dark:bg-white/6 text-muted-foreground/70 shrink-0">
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
                            "text-muted-foreground/0 group-hover:text-muted-foreground/70",
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
                {/* Editor header — pe-12 clears the dialog close X button */}
                <div className="flex items-center justify-between ps-5 pe-12 pt-4 pb-3 border-b border-border/70 dark:border-white/10">
                  <span className="text-xs font-medium text-muted-foreground/70">
                    {isTemplate
                      ? t(
                          isCreating
                            ? "notes.templates.addTemplate"
                            : "notes.templates.editTemplate"
                        )
                      : t(isCreating ? "notes.actions.addAction" : "notes.actions.editAction")}
                  </span>
                  <div className="flex items-center gap-2">
                    {isCreating && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setIsCreating(false);
                          resetForm();
                          // Re-select the first item if available
                          if (items.length > 0) handleSelectAction(items[0]);
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
                      disabled={isSaving || !canSave || !hasUnsavedChanges}
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
                    dir="auto"
                    ref={nameInputRef}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t(
                      isTemplate
                        ? "notes.templates.namePlaceholder"
                        : "notes.actions.namePlaceholder"
                    )}
                    maxLength={NOTE_ACTION_LIMITS.name}
                    disabled={isSaving}
                    className="h-9"
                  />
                  <Input
                    dir="auto"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t("notes.actions.descriptionPlaceholder")}
                    maxLength={NOTE_ACTION_LIMITS.description}
                    disabled={isSaving}
                    className="h-9"
                  />

                  {!isTemplate && (
                    <div className="space-y-1.5">
                      <Tabs
                        value={output}
                        onValueChange={(value) => setOutput(value as ActionOutput | "auto")}
                      >
                        <TabsList className="h-8 p-0.5">
                          {/* A saved action keeps the output it was given, so Auto is for new ones. */}
                          {editingId === null && (
                            <TabsTrigger value="auto" className="px-3 py-1 text-xs">
                              {t("notes.actions.output.auto")}
                            </TabsTrigger>
                          )}
                          <TabsTrigger value="chat" className="px-3 py-1 text-xs">
                            {t("notes.actions.output.chat")}
                          </TabsTrigger>
                          <TabsTrigger value="summary" className="px-3 py-1 text-xs">
                            {t("notes.actions.output.summary")}
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>
                      <p className="text-xs text-muted-foreground/70">
                        {t(OUTPUT_HINT_KEYS[output])}
                      </p>
                    </div>
                  )}

                  {/* Prompt — a template's context, or what an action does */}
                  <div className="flex flex-col flex-1 space-y-1.5 min-h-0">
                    <label className="text-xs font-medium text-foreground/50">
                      {t(isTemplate ? "notes.templates.contextLabel" : "notes.actions.promptLabel")}
                    </label>
                    <textarea
                      dir="auto"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={t(
                        isTemplate
                          ? "notes.templates.contextPlaceholder"
                          : "notes.actions.promptPlaceholder"
                      )}
                      maxLength={NOTE_ACTION_LIMITS.prompt}
                      disabled={isSaving}
                      className={cn(TEXTAREA_CLASS, "flex-1", isTemplate ? "min-h-24" : "min-h-50")}
                    />
                  </div>

                  {isTemplate && (
                    <div className="space-y-2">
                      <label className="text-xs font-medium text-foreground/50">
                        {t("notes.templates.sectionsLabel")}
                      </label>
                      {sections.length === 0 && (
                        <p className="text-xs text-muted-foreground/70">
                          {t("notes.templates.noSectionsHint")}
                        </p>
                      )}
                      {sections.map((section, index) => (
                        <div
                          key={section.key}
                          className="flex gap-2 rounded border border-border/70 p-2 dark:border-border-subtle/60"
                        >
                          <div className="flex-1 min-w-0 space-y-1.5">
                            <Input
                              dir="auto"
                              value={section.heading}
                              onChange={(e) =>
                                updateSection(section.key, { heading: e.target.value })
                              }
                              placeholder={t("notes.templates.sectionHeadingPlaceholder")}
                              maxLength={NOTE_ACTION_LIMITS.heading}
                              disabled={isSaving}
                              className="h-8"
                            />
                            <textarea
                              dir="auto"
                              rows={2}
                              value={section.instruction}
                              onChange={(e) =>
                                updateSection(section.key, { instruction: e.target.value })
                              }
                              placeholder={t("notes.templates.sectionInstructionPlaceholder")}
                              maxLength={NOTE_ACTION_LIMITS.instruction}
                              disabled={isSaving}
                              className={cn(TEXTAREA_CLASS, "py-2")}
                            />
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <button
                              type="button"
                              onClick={() => moveSection(index, -1)}
                              disabled={isSaving || index === 0}
                              aria-label={t("notes.templates.moveSectionUp")}
                              className={ICON_BUTTON_CLASS}
                            >
                              <ChevronUp size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveSection(index, 1)}
                              disabled={isSaving || index === sections.length - 1}
                              aria-label={t("notes.templates.moveSectionDown")}
                              className={ICON_BUTTON_CLASS}
                            >
                              <ChevronDown size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setSections((current) =>
                                  current.filter((s) => s.key !== section.key)
                                )
                              }
                              disabled={isSaving}
                              aria-label={t("notes.templates.removeSection")}
                              className={ICON_BUTTON_CLASS}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        </div>
                      ))}
                      <Button
                        variant="outline-flat"
                        size="sm"
                        onClick={() =>
                          setSections((current) => [
                            ...current,
                            { heading: "", instruction: "", key: crypto.randomUUID() },
                          ])
                        }
                        disabled={isSaving || sections.length >= NOTE_ACTION_LIMITS.sections}
                        className="h-7 text-xs gap-1.5"
                      >
                        <Plus size={12} />
                        {t("notes.templates.addSection")}
                      </Button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              /* Empty state — nothing selected */
              <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
                <div className="w-10 h-10 rounded-xl bg-accent/5 dark:bg-accent/8 flex items-center justify-center mb-3">
                  <Sparkles size={18} className="text-accent/30" />
                </div>
                <p className="text-sm font-medium text-foreground/45 mb-1">
                  {t(
                    isTemplate
                      ? "notes.templates.emptyEditorTitle"
                      : "notes.actions.emptyEditorTitle"
                  )}
                </p>
                <p className="text-xs text-muted-foreground/70 mb-4 max-w-52 leading-relaxed">
                  {t(
                    isTemplate
                      ? "notes.templates.emptyEditorDescription"
                      : "notes.actions.emptyEditorDescription"
                  )}
                </p>
                <Button
                  variant="outline-flat"
                  size="sm"
                  onClick={handleNewAction}
                  className="h-7 text-xs gap-1.5"
                >
                  <Plus size={12} />
                  {t(isTemplate ? "notes.templates.addTemplate" : "notes.actions.addAction")}
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
