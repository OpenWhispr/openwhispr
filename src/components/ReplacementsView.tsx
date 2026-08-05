import { useEffect, useRef, useState } from "react";
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
import { useSettings } from "../hooks/useSettings";
import type { DictionaryReplacement } from "../hooks/useSettings";

interface EditReplacementDialogProps {
  rule: DictionaryReplacement | null;
  onOpenChange: (open: boolean) => void;
  fromExists: (from: string, except: string) => boolean;
  onSave: (rule: DictionaryReplacement) => void;
}

function EditReplacementDialog({
  rule,
  onOpenChange,
  fromExists,
  onSave,
}: EditReplacementDialogProps) {
  const { t } = useTranslation();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    if (rule) {
      setFrom(rule.from);
      setTo(rule.to);
    }
  }, [rule]);

  const trimmedFrom = from.trim();
  const duplicate = !!rule && !!trimmedFrom && fromExists(trimmedFrom, rule.from);
  const canSave = !!trimmedFrom && !!to.trim() && !duplicate;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    onSave({ from: trimmedFrom, to: to.trim() });
  }

  return (
    <Dialog open={!!rule} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("dictionary.replacements.editTitle")}</DialogTitle>
          <DialogDescription>{t("dictionary.replacements.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="replacement-from" className="text-xs font-medium">
              {t("dictionary.replacements.hearsLabel")}
            </Label>
            <Input
              id="replacement-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder={t("dictionary.replacements.hearsPlaceholder")}
              maxLength={120}
            />
            {duplicate && (
              <p className="text-xs text-destructive">{t("dictionary.replacements.duplicate")}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="replacement-to" className="text-xs font-medium">
              {t("dictionary.replacements.replaceLabel")}
            </Label>
            <Input
              id="replacement-to"
              autoFocus
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={t("dictionary.replacements.replacePlaceholder")}
              maxLength={240}
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

export default function ReplacementsView() {
  const { t } = useTranslation();
  const { dictionaryReplacements, setDictionaryReplacements } = useSettings();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [editing, setEditing] = useState<DictionaryReplacement | null>(null);
  const fromInputRef = useRef<HTMLInputElement>(null);
  const toInputRef = useRef<HTMLInputElement>(null);

  const fromExists = (value: string, except?: string) => {
    const lower = value.toLowerCase();
    const exceptLower = except?.toLowerCase();
    return dictionaryReplacements.some((r) => {
      const existing = r.from.toLowerCase();
      return existing === lower && existing !== exceptLower;
    });
  };

  const trimmedFrom = from.trim();
  const duplicate = !!trimmedFrom && fromExists(trimmedFrom);
  const canAdd = !!trimmedFrom && !!to.trim() && !duplicate;

  const searchQuery = trimmedFrom.toLowerCase();
  const visibleRules =
    searchQuery && !to.trim()
      ? dictionaryReplacements.filter(
          (r) =>
            r.from.toLowerCase().includes(searchQuery) || r.to.toLowerCase().includes(searchQuery)
        )
      : dictionaryReplacements;

  const handleAdd = () => {
    if (!canAdd) return;
    setDictionaryReplacements([...dictionaryReplacements, { from: trimmedFrom, to: to.trim() }]);
    setFrom("");
    setTo("");
    fromInputRef.current?.focus();
  };

  const handleSaveEdit = (rule: DictionaryReplacement) => {
    setDictionaryReplacements(
      dictionaryReplacements.map((r) => (r.from === editing?.from ? rule : r))
    );
    setEditing(null);
  };

  const handleRemove = (removed: string) => {
    setDictionaryReplacements(dictionaryReplacements.filter((r) => r.from !== removed));
  };

  return (
    <div className="px-5 py-4 flex flex-col gap-3">
      <EditReplacementDialog
        rule={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        fromExists={fromExists}
        onSave={handleSaveEdit}
      />

      {/* ─── Add replacement ─── */}
      <div>
        <div className="flex items-center gap-2">
          <Input
            ref={fromInputRef}
            placeholder={t("dictionary.replacements.hearsPlaceholder")}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") toInputRef.current?.focus();
            }}
            maxLength={120}
            className="flex-1 h-8 text-xs placeholder:text-foreground/20"
          />
          <span className="text-xs text-foreground/20 shrink-0">→</span>
          <Input
            ref={toInputRef}
            placeholder={t("dictionary.replacements.replacePlaceholder")}
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            maxLength={240}
            className="flex-1 h-8 text-xs placeholder:text-foreground/20"
          />
          <Button size="sm" onClick={handleAdd} disabled={!canAdd}>
            {t("dictionary.add")}
          </Button>
        </div>
        {duplicate ? (
          <p className="mt-1.5 text-xs text-destructive">
            {t("dictionary.replacements.duplicate")}
          </p>
        ) : (
          <p className="mt-1.5 text-xs text-foreground/20">
            {t("dictionary.replacements.matchHint")}
          </p>
        )}
      </div>

      {/* ─── Replacement list ─── */}
      <div className="rounded-md border border-foreground/8 dark:border-white/6 bg-foreground/[0.02] dark:bg-white/[0.03] px-4 py-3">
        {dictionaryReplacements.length > 0 && (
          <>
            <h3 className="text-xs font-semibold text-foreground/40">
              {t("dictionary.replacements.title")}
            </h3>
            <div className="mt-2.5 border-t border-dashed border-foreground/10 dark:border-white/8" />
          </>
        )}

        {dictionaryReplacements.length === 0 ? (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-5 px-2 py-6">
            <div className="flex-1 min-w-[220px]">
              <h4 className="text-sm font-semibold text-foreground leading-snug">
                {t("dictionary.replacements.emptyTitle")}
              </h4>
              <p className="mt-1.5 text-xs text-foreground/30 leading-relaxed">
                {t("dictionary.replacements.emptyDescription")}
              </p>
              <Button size="sm" className="mt-4" onClick={() => fromInputRef.current?.focus()}>
                <Plus size={12} />
                {t("dictionary.replacements.new")}
              </Button>
            </div>
            <div className="flex-1 min-w-[220px] rounded-md border border-foreground/8 dark:border-white/6 bg-foreground/[0.02] dark:bg-white/[0.03] px-3.5 py-3">
              <div className="flex items-start gap-2">
                <span className="shrink-0 inline-flex items-center gap-1 rounded-[5px] bg-primary/10 dark:bg-primary/15 border border-primary/15 dark:border-primary/20 px-1.5 py-0.5 text-xs text-primary">
                  <Mic size={9} />
                  {t("dictionary.replacements.exampleFrom")}
                </span>
                <span className="shrink-0 text-xs text-foreground/20 mt-0.5">→</span>
                <span className="min-w-0 text-xs text-foreground/40 leading-relaxed">
                  {t("dictionary.replacements.exampleTo")}
                </span>
              </div>
            </div>
          </div>
        ) : visibleRules.length === 0 ? (
          <p className="py-6 text-xs text-foreground/20 text-center">
            {t("dictionary.noMatches", { word: trimmedFrom })}
          </p>
        ) : (
          <ul>
            {visibleRules.map((rule) => (
              <li
                key={rule.from}
                className="group flex items-center gap-2 h-9 border-b border-foreground/4 dark:border-white/3 last:border-b-0"
              >
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-xs text-foreground/60 shrink-0">{rule.from}</span>
                  <span className="text-xs text-foreground/20 shrink-0">→</span>
                  <span className="text-xs text-foreground/35 truncate">{rule.to}</span>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                  <button
                    onClick={() => setEditing(rule)}
                    aria-label={t("dictionary.replacements.edit", { from: rule.from })}
                    className="p-1 text-foreground/25 hover:text-foreground/60 transition-colors"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    onClick={() => handleRemove(rule.from)}
                    aria-label={t("dictionary.replacements.remove", { from: rule.from })}
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
