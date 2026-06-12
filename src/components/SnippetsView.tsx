import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Pencil, Plus, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { useSettings } from "../hooks/useSettings";
import type { Snippet } from "../utils/snippets";

const EXAMPLE_KEYS = ["linkedin", "rewrite", "intro", "signoff"] as const;

interface SnippetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: Snippet | null;
  isDuplicateTrigger: (trigger: string) => boolean;
  onSave: (snippet: Snippet) => void;
}

function SnippetDialog({
  open,
  onOpenChange,
  editing,
  isDuplicateTrigger,
  onSave,
}: SnippetDialogProps) {
  const { t } = useTranslation();
  const [trigger, setTrigger] = useState("");
  const [replacement, setReplacement] = useState("");

  useEffect(() => {
    if (open) {
      setTrigger(editing?.trigger ?? "");
      setReplacement(editing?.replacement ?? "");
    }
  }, [open, editing]);

  const trimmedTrigger = trigger.trim();
  const duplicate = !!trimmedTrigger && isDuplicateTrigger(trimmedTrigger);
  const canSave = !!trimmedTrigger && !!replacement.trim() && !duplicate;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    onSave({ trigger: trimmedTrigger, replacement: replacement.trim() });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? t("dictionary.snippets.editTitle") : t("dictionary.snippets.createTitle")}
          </DialogTitle>
          <DialogDescription>{t("dictionary.snippets.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="snippet-trigger" className="text-xs font-medium">
              {t("dictionary.snippets.triggerLabel")}
            </Label>
            <Input
              id="snippet-trigger"
              autoFocus={!editing}
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              placeholder={t("dictionary.snippets.triggerPlaceholder")}
              maxLength={80}
            />
            {duplicate && (
              <p className="text-xs text-destructive">{t("dictionary.snippets.duplicate")}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="snippet-replacement" className="text-xs font-medium">
              {t("dictionary.snippets.replacementLabel")}
            </Label>
            <Textarea
              id="snippet-replacement"
              autoFocus={!!editing}
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder={t("dictionary.snippets.replacementPlaceholder")}
              className="min-h-[96px] text-xs"
            />
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {editing ? t("common.save") : t("dictionary.snippets.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function SnippetsView() {
  const { t } = useTranslation();
  const { snippets, setSnippets } = useSettings();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Snippet | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (snippet: Snippet) => {
    setEditing(snippet);
    setDialogOpen(true);
  };

  const handleSave = (snippet: Snippet) => {
    setSnippets(
      editing
        ? snippets.map((s) => (s.trigger === editing.trigger ? snippet : s))
        : [...snippets, snippet]
    );
    setDialogOpen(false);
  };

  const handleRemove = (trigger: string) => {
    setSnippets(snippets.filter((s) => s.trigger !== trigger));
  };

  const isDuplicateTrigger = (trigger: string) => {
    const lower = trigger.toLowerCase();
    const editingLower = editing?.trigger.toLowerCase();
    return snippets.some((s) => {
      const existing = s.trigger.toLowerCase();
      return existing === lower && existing !== editingLower;
    });
  };

  return (
    <div className="px-5 py-4">
      <SnippetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        isDuplicateTrigger={isDuplicateTrigger}
        onSave={handleSave}
      />

      <div className="rounded-md border border-foreground/8 dark:border-white/6 bg-foreground/[0.02] dark:bg-white/[0.03] px-4 py-3">
        {snippets.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground/40">
                {t("dictionary.snippets.title")}
              </h3>
              <button
                onClick={openCreate}
                className="text-xs text-foreground/30 hover:text-primary transition-colors"
              >
                {t("dictionary.snippets.add")}
              </button>
            </div>
            <div className="mt-2.5 border-t border-dashed border-foreground/10 dark:border-white/8" />
          </>
        )}

        {snippets.length === 0 ? (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-5 px-2 py-6">
            <div className="flex-1 min-w-[220px]">
              <h4 className="text-sm font-semibold text-foreground leading-snug">
                {t("dictionary.snippets.emptyTitle")}{" "}
                <span className="text-primary">{t("dictionary.snippets.emptyTitleAccent")}</span>
              </h4>
              <p className="mt-1.5 text-xs text-foreground/30 leading-relaxed">
                {t("dictionary.snippets.emptyDescription")}
              </p>
              <Button size="sm" className="mt-4" onClick={openCreate}>
                <Plus size={12} />
                {t("dictionary.snippets.new")}
              </Button>
            </div>
            <div className="flex-1 min-w-[260px] rounded-md border border-foreground/8 dark:border-white/6 bg-foreground/[0.02] dark:bg-white/[0.03] px-3.5 py-3 flex flex-col gap-2.5">
              {EXAMPLE_KEYS.map((key) => (
                <div key={key} className="flex items-start gap-2">
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-[5px] bg-primary/10 dark:bg-primary/15 border border-primary/15 dark:border-primary/20 px-1.5 py-0.5 text-xs text-primary">
                    <Mic size={9} />
                    {t(`dictionary.snippets.examples.${key}Trigger`)}
                  </span>
                  <span className="shrink-0 text-xs text-foreground/20 mt-0.5">→</span>
                  <span className="min-w-0 text-xs text-foreground/40 leading-relaxed">
                    {t(`dictionary.snippets.examples.${key}Text`)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <ul>
            {snippets.map((snippet) => (
              <li
                key={snippet.trigger}
                className="group flex items-center gap-2 h-9 border-b border-foreground/4 dark:border-white/3 last:border-b-0"
              >
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-xs text-foreground/60 shrink-0">{snippet.trigger}</span>
                  <span className="text-xs text-foreground/20 shrink-0">→</span>
                  <span className="text-xs text-foreground/35 truncate">{snippet.replacement}</span>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                  <button
                    onClick={() => openEdit(snippet)}
                    aria-label={t("dictionary.snippets.edit", { trigger: snippet.trigger })}
                    className="p-1 text-foreground/25 hover:text-foreground/60 transition-colors"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    onClick={() => handleRemove(snippet.trigger)}
                    aria-label={t("dictionary.snippets.remove", { trigger: snippet.trigger })}
                    className="p-1 text-foreground/25 hover:text-destructive/70 transition-colors"
                  >
                    <X size={11} strokeWidth={2} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
