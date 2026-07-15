import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
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

interface EditSnippetDialogProps {
  snippet: Snippet | null;
  onOpenChange: (open: boolean) => void;
  triggerExists: (trigger: string, except: string) => boolean;
  onSave: (snippet: Snippet) => void;
}

function AppTag({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/20 px-2 py-0.5 text-xs text-primary">
      {name}
      <button
        type="button"
        onClick={onRemove}
        className="text-primary/50 hover:text-primary transition-colors"
        aria-label={`Remove ${name}`}
      >
        <X size={9} strokeWidth={2.5} />
      </button>
    </span>
  );
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
  const [apps, setApps] = useState<string[]>([]);
  const [appInput, setAppInput] = useState("");
  const [lastDetectedApp, setLastDetectedApp] = useState<string | null>(null);

  useEffect(() => {
    if (snippet) {
      setTrigger(snippet.trigger);
      setReplacement(snippet.replacement);
      setApps(snippet.apps ?? []);
      setAppInput("");
      window.electronAPI?.getLastTargetAppName?.().then((name: string | null) => {
        setLastDetectedApp(name || null);
      }).catch(() => {});
    }
  }, [snippet]);

  const trimmedTrigger = trigger.trim();
  const duplicate = !!snippet && !!trimmedTrigger && triggerExists(trimmedTrigger, snippet.trigger);
  const canSave = !!trimmedTrigger && !!replacement.trim() && !duplicate;

  function addApp() {
    const val = appInput.trim();
    if (!val || apps.some((a) => a.toLowerCase() === val.toLowerCase())) return;
    setApps([...apps, val]);
    setAppInput("");
  }

  function handleAppKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      addApp();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    onSave({ trigger: trimmedTrigger, replacement: replacement.trim(), apps });
  }

  return (
    <Dialog open={!!snippet} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {snippet?.trigger === "" ? t("dictionary.snippets.new") : t("dictionary.snippets.editTitle")}
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
              autoFocus
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
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder={t("dictionary.snippets.replacementPlaceholder")}
              className="min-h-[96px] text-xs"
            />
          </div>

          {/* App filter */}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Only in apps</Label>
            <p className="text-[11px] text-foreground/40 leading-relaxed">
              Leave empty to apply in all applications. Type a partial app name (e.g. <span className="font-mono">slack</span>, <span className="font-mono">chrome</span>).
            </p>
            {lastDetectedApp && !apps.some((a) => a.toLowerCase() === lastDetectedApp.toLowerCase()) && (
              <p className="text-[11px] text-foreground/40">
                Last detected:{" "}
                <button
                  type="button"
                  onClick={() => setApps([...apps, lastDetectedApp])}
                  className="font-mono text-primary/70 hover:text-primary underline underline-offset-2 transition-colors"
                >
                  {lastDetectedApp}
                </button>
              </p>
            )}
            <div className="flex gap-1.5">
              <Input
                value={appInput}
                onChange={(e) => setAppInput(e.target.value)}
                onKeyDown={handleAppKeyDown}
                placeholder="App name…"
                className="h-7 text-xs flex-1"
                maxLength={60}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addApp}
                disabled={!appInput.trim()}
                className="h-7 px-2 text-xs"
              >
                <Plus size={11} />
              </Button>
            </div>
            {apps.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {apps.map((a) => (
                  <AppTag key={a} name={a} onRemove={() => setApps(apps.filter((x) => x !== a))} />
                ))}
              </div>
            )}
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
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Snippet | null>(null);

  const triggerExists = (value: string, except?: string) => {
    const lower = value.toLowerCase();
    const exceptLower = except?.toLowerCase();
    return snippets.some((s) => {
      const existing = s.trigger.toLowerCase();
      return existing === lower && existing !== exceptLower;
    });
  };

  const searchQuery = search.trim().toLowerCase();
  const visibleSnippets = searchQuery
    ? snippets.filter(
        (s) =>
          s.trigger.toLowerCase().includes(searchQuery) ||
          s.replacement.toLowerCase().includes(searchQuery)
      )
    : snippets;

  const openNewDialog = () => setEditing({ trigger: "", replacement: "", apps: [] });

  const handleSaveEdit = (snippet: Snippet) => {
    if (editing?.trigger === "") {
      setSnippets([...snippets, snippet]);
    } else {
      setSnippets(snippets.map((s) => (s.trigger === editing?.trigger ? snippet : s)));
    }
    setEditing(null);
  };

  const handleRemove = (removed: string) => {
    setSnippets(snippets.filter((s) => s.trigger !== removed));
  };

  return (
    <div className="px-5 py-4 flex flex-col gap-3">
      <EditSnippetDialog
        snippet={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        triggerExists={triggerExists}
        onSave={handleSaveEdit}
      />

      {/* ─── Header: search + add button ─── */}
      <div className="flex items-center gap-2">
        <Input
          placeholder={t("dictionary.snippets.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 h-8 text-xs placeholder:text-foreground/20"
        />
        <Button size="sm" onClick={openNewDialog} className="h-8 shrink-0 gap-1.5">
          <Plus size={12} />
          {t("dictionary.snippets.new")}
        </Button>
      </div>

      {/* ─── Snippet list ─── */}
      <div className="rounded-md border border-foreground/8 dark:border-white/6 bg-foreground/[0.02] dark:bg-white/[0.03] px-4 py-3">
        {snippets.length > 0 && (
          <>
            <h3 className="text-xs font-semibold text-foreground/40">
              {t("dictionary.snippets.title")}
            </h3>
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
        ) : visibleSnippets.length === 0 ? (
          <p className="py-6 text-xs text-foreground/20 text-center">
            {t("dictionary.snippets.searchNoMatches", { word: search.trim() })}
          </p>
        ) : (
          <ul>
            {visibleSnippets.map((snippet) => (
              <li
                key={snippet.trigger}
                className="group flex items-center gap-2 h-9 border-b border-foreground/4 dark:border-white/3 last:border-b-0"
              >
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-xs text-foreground/60 shrink-0">{snippet.trigger}</span>
                  <span className="text-xs text-foreground/20 shrink-0">→</span>
                  <span className="text-xs text-foreground/35 truncate">{snippet.replacement}</span>
                  {snippet.apps && snippet.apps.length > 0 && (
                    <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-primary/8 border border-primary/15 px-1.5 py-px text-[10px] text-primary/60">
                      {snippet.apps.join(", ")}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                  <button
                    onClick={() => setEditing(snippet)}
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
