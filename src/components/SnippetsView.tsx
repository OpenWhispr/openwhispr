import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft, Pencil, Plus, X } from "./icons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { PAGE_CONTENT_WIDTH_CLASS } from "./ui/pageWidth";
import { cn } from "./lib/utils";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { useSettings } from "../hooks/useSettings";
import { getCachedPlatform } from "../utils/platform";
import type { Snippet } from "../utils/snippets";
import DictionaryEmptyIllustration from "./DictionaryEmptyIllustration";

interface EditSnippetDialogProps {
  snippet: Snippet | null;
  onOpenChange: (open: boolean) => void;
  triggerExists: (trigger: string, except: string) => boolean;
  onSave: (snippet: Snippet) => void;
}

function EditSnippetDialog({
  snippet,
  onOpenChange,
  triggerExists,
  onSave,
}: EditSnippetDialogProps) {
  const { t } = useTranslation();
  const [trigger, setTrigger] = useState("");
  const [replacement, setReplacement] = useState("");

  useEffect(() => {
    if (snippet) {
      setTrigger(snippet.trigger);
      setReplacement(snippet.replacement);
    }
  }, [snippet]);

  const trimmedTrigger = trigger.trim();
  const duplicate = !!snippet && !!trimmedTrigger && triggerExists(trimmedTrigger, snippet.trigger);
  const canSave = !!trimmedTrigger && !!replacement.trim() && !duplicate;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    onSave({ trigger: trimmedTrigger, replacement: replacement.trim() });
  }

  return (
    <Dialog open={!!snippet} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("dictionary.snippets.editTitle")}</DialogTitle>
          <DialogDescription>{t("dictionary.snippets.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="snippet-trigger" className="text-xs font-medium">
              {t("dictionary.snippets.triggerLabel")}
            </Label>
            <Input
              dir="auto"
              id="snippet-trigger"
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
              dir="auto"
              id="snippet-replacement"
              autoFocus
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
              {t("common.save")}
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
  const [trigger, setTrigger] = useState("");
  const [expansion, setExpansion] = useState("");
  const [showEmptyInput, setShowEmptyInput] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [editing, setEditing] = useState<Snippet | null>(null);
  const triggerInputRef = useRef<HTMLInputElement>(null);

  const triggerExists = (value: string, except?: string) => {
    const lower = value.toLowerCase();
    const exceptLower = except?.toLowerCase();
    return snippets.some((s) => {
      const existing = s.trigger.toLowerCase();
      return existing === lower && existing !== exceptLower;
    });
  };

  const trimmedTrigger = trigger.trim();
  const duplicate = !!trimmedTrigger && triggerExists(trimmedTrigger);

  const searchQuery = trimmedTrigger.toLowerCase();
  const visibleSnippets =
    searchQuery && !panelOpen
      ? snippets.filter(
          (s) =>
            s.trigger.toLowerCase().includes(searchQuery) ||
            s.replacement.toLowerCase().includes(searchQuery)
        )
      : snippets;

  const openPanel = () => {
    if (!trimmedTrigger || duplicate) return;
    setPanelOpen(true);
  };

  const closePanel = () => {
    setPanelOpen(false);
    setExpansion("");
    triggerInputRef.current?.focus();
  };

  const handleCreate = () => {
    setSnippets([...snippets, { trigger: trimmedTrigger, replacement: expansion.trim() }]);
    setTrigger("");
    setShowEmptyInput(false);
    closePanel();
  };

  const handleSaveEdit = (snippet: Snippet) => {
    setSnippets(snippets.map((s) => (s.trigger === editing?.trigger ? snippet : s)));
    setEditing(null);
  };

  const handleRemove = (removed: string) => {
    setSnippets(snippets.filter((s) => s.trigger !== removed));
  };

  const canCreate = !!trimmedTrigger && !!expansion.trim() && !duplicate;

  const triggerInput = (
    <div>
      <div className="relative">
        <Input
          dir="auto"
          ref={triggerInputRef}
          autoFocus={snippets.length === 0}
          placeholder={t("dictionary.snippets.addPlaceholder")}
          value={trigger}
          onChange={(e) => setTrigger(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") openPanel();
            if (e.key === "Escape" && snippets.length === 0 && !panelOpen) setShowEmptyInput(false);
          }}
          maxLength={80}
          className="h-10 w-full pe-16 text-sm placeholder:text-foreground/45"
        />
        <button
          onClick={openPanel}
          disabled={!trimmedTrigger || duplicate}
          aria-label={t("dictionary.snippets.create")}
          className="absolute end-3 top-1/2 flex -translate-y-1/2 items-center gap-1 text-xs text-foreground/45 transition-colors enabled:hover:text-primary disabled:text-foreground/45"
        >
          {t("dictionary.add")}
          <CornerDownLeft size={12} />
        </button>
      </div>
      {duplicate && (
        <p className="mt-1.5 text-xs text-destructive">{t("dictionary.snippets.duplicate")}</p>
      )}
    </div>
  );

  const expansionPanel = (
    <div className="rounded-xl border border-primary/30 px-3 pb-2 pt-2.5 dark:border-primary/40">
      <Textarea
        dir="auto"
        autoFocus
        value={expansion}
        onChange={(e) => setExpansion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") closePanel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCreate) handleCreate();
        }}
        placeholder={t("dictionary.snippets.replacementPlaceholder")}
        rows={4}
        className="min-h-[72px] resize-none rounded-none border-0 bg-transparent p-0 text-xs text-foreground shadow-none placeholder:text-foreground/45 hover:border-0 focus:border-0 focus:ring-0"
      />
      <div className="flex items-center justify-between pt-1.5">
        <div dir="ltr" className="flex items-center gap-0.5">
          <kbd className="rounded border border-border/70 bg-muted/40 px-1 py-px font-mono text-[10px] leading-tight text-muted-foreground/70 dark:border-white/10">
            {getCachedPlatform() === "darwin" ? "⌘" : "Ctrl"}
          </kbd>
          <kbd className="rounded border border-border/70 bg-muted/40 px-1 py-px font-mono text-[10px] leading-tight text-muted-foreground/70 dark:border-white/10">
            ⏎
          </kbd>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={closePanel}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={!canCreate}>
            {t("dictionary.snippets.create")}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "max-w-7xl flex flex-col gap-3 px-6 py-5")}>
      <EditSnippetDialog
        snippet={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        triggerExists={triggerExists}
        onSave={handleSaveEdit}
      />

      {/* ─── Add snippet ─── */}
      {snippets.length > 0 && triggerInput}

      {/* ─── Expansion panel ─── */}
      {panelOpen && snippets.length > 0 && expansionPanel}

      {/* ─── Snippet list ─── */}
      <div
        className={cn(
          "border border-border/70 bg-card/50 shadow-sm dark:border-white/10 dark:bg-surface-2/60",
          snippets.length > 0
            ? "rounded-2xl px-4 py-3"
            : "relative overflow-hidden rounded-3xl dark:bg-surface-window"
        )}
      >
        {snippets.length > 0 && (
          <>
            <h3 className="text-xs font-semibold text-foreground/45">
              {t("dictionary.snippets.title")}
            </h3>
            <div className="mt-2.5 border-t border-dashed border-foreground/10 dark:border-white/10" />
          </>
        )}

        {snippets.length === 0 ? (
          <div className="flex min-h-64 items-start px-6 py-6">
            <div className="relative z-10 w-full min-w-0 md:w-3/5">
              <h2 className="text-xl font-semibold leading-snug text-foreground">
                {t("dictionary.snippets.emptyTitle")} {t("dictionary.snippets.emptyTitleAccent")}
              </h2>
              <p className="mt-3 max-w-xl text-base leading-relaxed text-muted-foreground">
                {t("dictionary.snippets.emptyDescription")}
              </p>
              {showEmptyInput ? (
                <div className="mt-6 max-w-md space-y-3">
                  {triggerInput}
                  {panelOpen && expansionPanel}
                </div>
              ) : (
                <Button className="mt-6 px-5" onClick={() => setShowEmptyInput(true)}>
                  <Plus size={16} />
                  {t("dictionary.snippets.new")}
                </Button>
              )}
            </div>
            <DictionaryEmptyIllustration variant="snippets" />
          </div>
        ) : visibleSnippets.length === 0 ? (
          <p className="py-6 text-xs text-foreground/45 text-center">
            {t("dictionary.noMatches", { word: trimmedTrigger })}
          </p>
        ) : (
          <ul>
            {visibleSnippets.map((snippet) => (
              <li
                key={snippet.trigger}
                className="group flex items-center gap-2 h-9 border-b border-foreground/4 dark:border-white/10 last:border-b-0"
              >
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span dir="auto" className="text-xs text-foreground/60 shrink-0">
                    {snippet.trigger}
                  </span>
                  <span className="text-xs text-foreground/45 shrink-0">→</span>
                  <span dir="auto" className="text-xs text-foreground/45 truncate">
                    {snippet.replacement}
                  </span>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                  <button
                    onClick={() => setEditing(snippet)}
                    aria-label={t("dictionary.snippets.edit", { trigger: snippet.trigger })}
                    className="p-1 text-foreground/45 hover:text-foreground/60 transition-colors"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    onClick={() => handleRemove(snippet.trigger)}
                    aria-label={t("dictionary.snippets.remove", { trigger: snippet.trigger })}
                    className="p-1 text-foreground/45 hover:text-destructive/70 transition-colors"
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
