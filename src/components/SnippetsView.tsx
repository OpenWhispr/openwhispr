import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Scissors, X, Info } from "lucide-react";
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

const EXAMPLES = ["cal link → cal.com/you/30min", "my handle → @you"];

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
  const [showInfo, setShowInfo] = useState(false);

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

  const isDuplicateTrigger = (trigger: string) =>
    snippets.some(
      (s) =>
        s.trigger.toLowerCase() === trigger.toLowerCase() &&
        s.trigger.toLowerCase() !== editing?.trigger.toLowerCase()
    );

  return (
    <div className="flex flex-col h-full">
      <SnippetDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        isDuplicateTrigger={isDuplicateTrigger}
        onSave={handleSave}
      />

      {snippets.length === 0 ? (
        /* ─── Empty state ─── */
        <div className="flex-1 flex flex-col items-center justify-center px-8 -mt-4">
          <div className="w-10 h-10 rounded-[10px] bg-gradient-to-b from-primary/8 to-primary/4 dark:from-primary/12 dark:to-primary/6 border border-primary/10 dark:border-primary/15 flex items-center justify-center mb-4">
            <Scissors
              size={17}
              strokeWidth={1.5}
              className="text-primary/50 dark:text-primary/60"
            />
          </div>

          <h2 className="text-xs font-semibold text-foreground mb-1">
            {t("dictionary.snippets.title")}
          </h2>
          <p className="text-xs text-foreground/30 text-center leading-relaxed max-w-[240px] mb-6">
            {t("dictionary.snippets.description")}
          </p>

          <Button size="sm" onClick={openCreate}>
            {t("dictionary.snippets.new")}
          </Button>

          <div className="flex items-center gap-1.5 mt-3">
            {EXAMPLES.map((ex) => (
              <span
                key={ex}
                className="text-xs text-foreground/12 px-1.5 py-0.5 rounded-[4px] border border-dashed border-foreground/6 dark:border-white/5"
              >
                {ex}
              </span>
            ))}
          </div>

          <div className="mt-8 w-full max-w-[260px]">
            <button
              onClick={() => setShowInfo(!showInfo)}
              aria-expanded={showInfo}
              aria-label={t("dictionary.howItWorks")}
              className="flex items-center gap-1 text-xs text-foreground/15 hover:text-foreground/30 transition-colors mx-auto"
            >
              <Info size={9} />
              {t("dictionary.howItWorks")}
            </button>
            {showInfo && (
              <div className="mt-2.5 rounded-md bg-foreground/[0.02] dark:bg-white/[0.02] border border-foreground/5 dark:border-white/4 px-3 py-2.5">
                <p className="text-xs text-foreground/25 leading-[1.6]">
                  {t("dictionary.snippets.howItWorksDetail")}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ─── Populated state ─── */
        <>
          <div className="px-5 pt-3 pb-2.5 flex items-baseline justify-between">
            <div className="flex items-baseline gap-2">
              <h2 className="text-xs font-semibold text-foreground">
                {t("dictionary.snippets.title")}
              </h2>
              <span className="text-xs text-foreground/15 font-mono tabular-nums">
                {snippets.length}
              </span>
            </div>
            <button
              onClick={openCreate}
              className="text-xs text-primary/60 hover:text-primary transition-colors"
            >
              {t("dictionary.snippets.add")}
            </button>
          </div>

          <div className="mx-5 h-px bg-border/8 dark:bg-white/3" />

          <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1">
            {snippets.map((snippet) => (
              <div
                key={snippet.trigger}
                className="group flex items-center rounded-[5px] border border-foreground/8 dark:border-white/6 bg-foreground/[0.02] dark:bg-white/[0.03] hover:border-foreground/15 dark:hover:border-white/12 hover:bg-foreground/[0.04] dark:hover:bg-white/[0.06] transition-colors duration-150"
              >
                <button
                  onClick={() => openEdit(snippet)}
                  className="flex-1 min-w-0 flex items-center gap-2 pl-2.5 py-1.5 text-left"
                  aria-label={t("dictionary.snippets.edit", { trigger: snippet.trigger })}
                >
                  <span className="text-xs font-medium text-foreground/70 dark:text-foreground/60 shrink-0">
                    {snippet.trigger}
                  </span>
                  <span className="text-xs text-foreground/20 shrink-0">→</span>
                  <span className="text-xs text-foreground/40 dark:text-foreground/35 truncate">
                    {snippet.replacement}
                  </span>
                </button>
                <button
                  onClick={() => handleRemove(snippet.trigger)}
                  aria-label={t("dictionary.snippets.remove", { trigger: snippet.trigger })}
                  className="p-0.5 mx-1.5 rounded-sm
                    opacity-0 group-hover:opacity-100
                    text-foreground/25 hover:!text-destructive/70
                    transition-colors duration-150"
                >
                  <X size={10} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>

          <div className="px-5 pb-3 flex items-start gap-1.5">
            <Info size={9} className="text-foreground/10 mt-px shrink-0" />
            <p className="text-xs text-foreground/12 leading-relaxed">
              {t("dictionary.snippets.inputHint")}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
