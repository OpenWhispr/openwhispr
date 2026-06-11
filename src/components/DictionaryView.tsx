import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft, Download, Pencil, Upload, X } from "lucide-react";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { useToast } from "./ui/useToast";
import { useSettings } from "../hooks/useSettings";
import { getAgentName } from "../utils/agentName";

const parseWords = (text: string): string[] =>
  text
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter(Boolean);

export default function DictionaryView() {
  const { t } = useTranslation();
  const { customDictionary, setCustomDictionary } = useSettings();
  const agentName = getAgentName();
  const { toast } = useToast();

  const [newWord, setNewWord] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [editingWord, setEditingWord] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const pendingImportCount = useMemo(() => parseWords(bulkText).length, [bulkText]);

  const searchQuery = newWord.trim().toLowerCase();
  const visibleWords = useMemo(
    () =>
      searchQuery
        ? customDictionary.filter((w) => w.toLowerCase().includes(searchQuery))
        : customDictionary,
    [customDictionary, searchQuery]
  );

  const addWords = useCallback(
    (text: string): number => {
      const existing = new Set(customDictionary.map((w) => w.toLowerCase()));
      const words = parseWords(text).filter((w) => {
        if (existing.has(w.toLowerCase())) return false;
        existing.add(w.toLowerCase());
        return true;
      });
      if (words.length > 0) {
        setCustomDictionary([...customDictionary, ...words]);
      }
      return words.length;
    },
    [customDictionary, setCustomDictionary]
  );

  const handleAdd = useCallback(() => {
    if (addWords(newWord) > 0) setNewWord("");
  }, [addWords, newWord]);

  const handleImport = useCallback(() => {
    addWords(bulkText);
    setBulkText("");
    setShowBulkImport(false);
  }, [addWords, bulkText]);

  const handleRemove = useCallback(
    (word: string) => {
      if (word === agentName) return;
      setCustomDictionary(customDictionary.filter((w) => w !== word));
    },
    [customDictionary, setCustomDictionary, agentName]
  );

  const startEdit = useCallback((word: string) => {
    setEditingWord(word);
    setEditValue(word);
  }, []);

  const commitEdit = useCallback(() => {
    if (!editingWord) return;
    const trimmed = editValue.trim();
    const isDuplicate = customDictionary.some(
      (w) => w !== editingWord && w.toLowerCase() === trimmed.toLowerCase()
    );
    if (trimmed && trimmed !== editingWord && !isDuplicate) {
      setCustomDictionary(customDictionary.map((w) => (w === editingWord ? trimmed : w)));
    }
    setEditingWord(null);
  }, [editingWord, editValue, customDictionary, setCustomDictionary]);

  const handleExport = useCallback(async () => {
    const result = await window.electronAPI?.exportDictionary?.(customDictionary);
    if (result?.error) {
      toast({
        title: t("dictionary.exportFailed"),
        description: result.error,
        variant: "destructive",
      });
    }
  }, [customDictionary, toast, t]);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t("dictionary.clearTitle")}
        description={t("dictionary.clearDescription")}
        onConfirm={() => setCustomDictionary(customDictionary.filter((w) => w === agentName))}
        variant="destructive"
      />

      <div className="px-5 py-4 flex flex-col gap-3">
        {/* ─── Add word ─── */}
        <div>
          <div className="relative">
            <Input
              placeholder={t("dictionary.addPlaceholder")}
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
              }}
              className="w-full h-8 text-xs pr-24 placeholder:text-foreground/20"
            />
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-2">
              <button
                onClick={handleAdd}
                disabled={!newWord.trim()}
                aria-label={t("dictionary.addWord")}
                className="flex items-center gap-1 text-xs text-foreground/30 enabled:hover:text-primary disabled:text-foreground/15 transition-colors"
              >
                {t("dictionary.add")}
                <CornerDownLeft size={10} />
              </button>
              <div className="w-px h-3.5 bg-foreground/10 dark:bg-white/8" />
              <button
                onClick={() => setShowBulkImport(true)}
                aria-label={t("dictionary.importWords")}
                className="text-foreground/30 hover:text-foreground/60 transition-colors"
              >
                <Upload size={11} />
              </button>
            </div>
          </div>
          <p className="mt-1.5 text-xs text-foreground/15">{t("dictionary.separatorHint")}</p>
        </div>

        {/* ─── Bulk import ─── */}
        {showBulkImport && (
          <div className="rounded-md border border-primary/30 dark:border-primary/40 px-3 pt-2.5 pb-2">
            <Textarea
              autoFocus
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={t("dictionary.importPlaceholder")}
              rows={4}
              className="min-h-[72px] resize-none border-0 shadow-none rounded-none bg-transparent p-0 text-xs text-foreground placeholder:text-foreground/20 hover:border-0 focus:border-0 focus:ring-0"
            />
            <div className="flex items-center justify-between pt-1.5">
              <p className="text-xs text-foreground/20">
                {t("dictionary.separateWithCommas")}
                {pendingImportCount > 0 && (
                  <span className="text-success">
                    {" • "}
                    {t("dictionary.wordsReady", { count: pendingImportCount })}
                  </span>
                )}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setBulkText("");
                    setShowBulkImport(false);
                  }}
                >
                  {t("common.cancel")}
                </Button>
                <Button size="sm" onClick={handleImport} disabled={pendingImportCount === 0}>
                  {t("dictionary.import")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Dictionary list ─── */}
        <div className="rounded-md border border-foreground/8 dark:border-white/6 bg-foreground/[0.02] dark:bg-white/[0.03] px-4 py-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground/40">
              {t("dictionary.yourDictionary")}
            </h3>
            <div className="flex items-center gap-3">
              {customDictionary.length > 0 && (
                <button
                  onClick={() => setConfirmClear(true)}
                  aria-label={t("dictionary.clearAll")}
                  className="text-xs text-foreground/15 hover:text-destructive/70 transition-colors"
                >
                  {t("dictionary.clearAll")}
                </button>
              )}
              <button
                onClick={handleExport}
                disabled={customDictionary.length === 0}
                aria-label={t("dictionary.exportDictionary")}
                className="text-foreground/25 enabled:hover:text-foreground/60 disabled:text-foreground/10 transition-colors"
              >
                <Download size={12} />
              </button>
            </div>
          </div>
          <div className="mt-2.5 border-t border-dashed border-foreground/10 dark:border-white/8" />

          {customDictionary.length === 0 ? (
            <p className="py-6 text-xs text-foreground/20 text-center">{t("dictionary.empty")}</p>
          ) : visibleWords.length === 0 ? (
            <p className="py-6 text-xs text-foreground/20 text-center">
              {t("dictionary.noMatches", { word: newWord.trim() })}
            </p>
          ) : (
            <ul>
              {visibleWords.map((word) => {
                const isAgentName = word === agentName;
                const isEditing = editingWord === word;
                return (
                  <li
                    key={word}
                    className="group flex items-center gap-2 h-9 border-b border-foreground/4 dark:border-white/3 last:border-b-0"
                    title={isAgentName ? t("dictionary.autoManaged") : undefined}
                  >
                    {isEditing ? (
                      <Input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit();
                          if (e.key === "Escape") setEditingWord(null);
                        }}
                        onBlur={commitEdit}
                        className="h-7 text-xs flex-1"
                      />
                    ) : (
                      <span
                        className={`flex-1 text-xs truncate ${
                          isAgentName ? "text-primary" : "text-foreground/60"
                        }`}
                      >
                        {word}
                      </span>
                    )}
                    {!isAgentName && !isEditing && (
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                        <button
                          onClick={() => startEdit(word)}
                          aria-label={t("dictionary.editWord", { word })}
                          className="p-1 text-foreground/25 hover:text-foreground/60 transition-colors"
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          onClick={() => handleRemove(word)}
                          aria-label={t("dictionary.removeWord", { word })}
                          className="p-1 text-foreground/25 hover:text-destructive/70 transition-colors"
                        >
                          <X size={11} strokeWidth={2} />
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
