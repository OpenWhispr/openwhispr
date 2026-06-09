import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Replace, Plus, Trash2, Info } from "lucide-react";
import { Input } from "./ui/input";
import { ConfirmDialog } from "./ui/dialog";
import { useSettings } from "../hooks/useSettings";
import type { CustomPhrase } from "../types/phrases";

function makeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function PhrasesView() {
  const { t } = useTranslation();
  const { customPhrases, setCustomPhrases } = useSettings();
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  const isEmpty = customPhrases.length === 0;

  const handleAdd = useCallback(() => {
    const next: CustomPhrase = { id: makeId(), trigger: "", snippet: "" };
    setCustomPhrases([...customPhrases, next]);
  }, [customPhrases, setCustomPhrases]);

  const handleUpdate = useCallback(
    (id: string, patch: Partial<CustomPhrase>) => {
      setCustomPhrases(customPhrases.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    },
    [customPhrases, setCustomPhrases]
  );

  const handleRemove = useCallback(
    (id: string) => {
      setCustomPhrases(customPhrases.filter((p) => p.id !== id));
    },
    [customPhrases, setCustomPhrases]
  );

  return (
    <div className="flex flex-col h-full">
      <ConfirmDialog
        open={confirmRemoveId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemoveId(null);
        }}
        title={t("phrases.removeTitle")}
        description={t("phrases.removeDescription")}
        onConfirm={() => {
          if (confirmRemoveId) handleRemove(confirmRemoveId);
          setConfirmRemoveId(null);
        }}
        variant="destructive"
      />

      {isEmpty ? (
        /* ─── Empty state ─── */
        <div className="flex-1 flex flex-col items-center justify-center px-8 -mt-4">
          <div className="w-10 h-10 rounded-[10px] bg-gradient-to-b from-primary/8 to-primary/4 dark:from-primary/12 dark:to-primary/6 border border-primary/10 dark:border-primary/15 flex items-center justify-center mb-4">
            <Replace
              size={17}
              strokeWidth={1.5}
              className="text-primary/50 dark:text-primary/60"
            />
          </div>

          <h2 className="text-xs font-semibold text-foreground mb-1">{t("phrases.title")}</h2>
          <p className="text-xs text-foreground/30 text-center leading-relaxed max-w-[280px] mb-6">
            {t("phrases.description")}
          </p>

          <button
            onClick={handleAdd}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md bg-primary/10 hover:bg-primary/15 dark:bg-primary/15 dark:hover:bg-primary/20 text-primary text-xs font-medium transition-colors"
          >
            <Plus size={11} strokeWidth={2} />
            {t("phrases.addFirst")}
          </button>

          <div className="mt-8 w-full max-w-[280px]">
            <button
              onClick={() => setShowInfo(!showInfo)}
              aria-expanded={showInfo}
              className="flex items-center gap-1 text-xs text-foreground/15 hover:text-foreground/30 transition-colors mx-auto"
            >
              <Info size={9} />
              {t("phrases.howItWorks")}
            </button>
            {showInfo && (
              <div className="mt-2.5 rounded-md bg-foreground/[0.02] dark:bg-white/[0.02] border border-foreground/5 dark:border-white/4 px-3 py-2.5">
                <p className="text-xs text-foreground/25 leading-[1.6]">
                  {t("phrases.howItWorksDetail")}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ─── Populated state ─── */
        <>
          <div className="px-5 pt-4 pb-2.5 flex items-baseline justify-between">
            <div className="flex items-baseline gap-2">
              <h2 className="text-xs font-semibold text-foreground">{t("phrases.title")}</h2>
              <span className="text-xs text-foreground/15 font-mono tabular-nums">
                {customPhrases.length}
              </span>
            </div>
            <button
              onClick={handleAdd}
              className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors"
            >
              <Plus size={11} strokeWidth={2} />
              {t("phrases.add")}
            </button>
          </div>

          <div className="mx-5 h-px bg-border/8 dark:bg-white/3" />

          <div className="px-5 py-2 grid grid-cols-[1fr_2fr_auto] gap-3 items-center">
            <span className="text-xs text-foreground/35 font-medium uppercase tracking-wide">
              {t("phrases.triggerColumn")}
            </span>
            <span className="text-xs text-foreground/35 font-medium uppercase tracking-wide">
              {t("phrases.snippetColumn")}
            </span>
            <span className="w-6" />
          </div>

          <div className="mx-5 h-px bg-border/8 dark:bg-white/3" />

          <div className="flex-1 overflow-y-auto px-5 py-3">
            <div className="flex flex-col gap-2">
              {customPhrases.map((phrase) => (
                <div
                  key={phrase.id}
                  className="grid grid-cols-[1fr_2fr_auto] gap-3 items-start"
                >
                  <Input
                    value={phrase.trigger}
                    onChange={(e) => handleUpdate(phrase.id, { trigger: e.target.value })}
                    placeholder={t("phrases.triggerPlaceholder")}
                    className="h-8 text-xs"
                  />
                  <textarea
                    value={phrase.snippet}
                    onChange={(e) => handleUpdate(phrase.id, { snippet: e.target.value })}
                    placeholder={t("phrases.snippetPlaceholder")}
                    rows={1}
                    className="[field-sizing:content] min-h-8 w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs text-foreground placeholder:text-foreground/25 outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/40 resize-none"
                  />
                  <button
                    onClick={() => setConfirmRemoveId(phrase.id)}
                    aria-label={t("phrases.delete")}
                    className="h-8 w-6 inline-flex items-center justify-center text-foreground/25 hover:text-destructive/70 transition-colors"
                  >
                    <Trash2 size={12} strokeWidth={1.75} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="px-5 pb-3 flex items-start gap-1.5">
            <Info size={9} className="text-foreground/10 mt-px shrink-0" />
            <p className="text-xs text-foreground/12 leading-relaxed">
              {t("phrases.inputHint")}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
