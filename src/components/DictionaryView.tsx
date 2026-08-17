import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  CornerDownLeft,
  Download,
  Pencil,
  Plus,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { EmptyState } from "./ui/EmptyState";
import { useToast } from "./ui/useToast";
import SnippetsView from "./SnippetsView";
import { useSettings } from "../hooks/useSettings";
import { getAgentName } from "../utils/agentName";
import { parseDictionaryImportText } from "../helpers/dictionaryImport";

export default function DictionaryView() {
  const { t } = useTranslation();
  const { customDictionary, updateCustomDictionary } = useSettings();
  const agentName = getAgentName();
  const { toast } = useToast();

  const [newWord, setNewWord] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [editingWord, setEditingWord] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const addInputRef = useRef<HTMLInputElement>(null);

  const pendingImportCount = useMemo(() => parseDictionaryImportText(bulkText).length, [bulkText]);

  // Same membership rule as agentNameDictionaryChanges: a stored spelling that
  // differs only by case is still the agent name's entry, so keep it hidden.
  const userWords = useMemo(() => {
    const agentWord = agentName.trim().toLowerCase();
    return customDictionary.filter((w) => w.trim().toLowerCase() !== agentWord);
  }, [customDictionary, agentName]);

  const searchQuery = newWord.trim().toLowerCase();
  const visibleWords = useMemo(
    () =>
      searchQuery ? userWords.filter((w) => w.toLowerCase().includes(searchQuery)) : userWords,
    [userWords, searchQuery]
  );

  const addWords = useCallback(
    (text: string): number => {
      const existing = new Set(customDictionary.map((w) => w.toLowerCase()));
      const words = parseDictionaryImportText(text).filter((w) => {
        if (existing.has(w.toLowerCase())) return false;
        existing.add(w.toLowerCase());
        return true;
      });
      if (words.length > 0) {
        updateCustomDictionary({ add: words });
      }
      return words.length;
    },
    [customDictionary, updateCustomDictionary]
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
      updateCustomDictionary({ remove: [word] });
    },
    [updateCustomDictionary]
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
      updateCustomDictionary({ add: [trimmed], remove: [editingWord] });
    }
    setEditingWord(null);
  }, [editingWord, editValue, customDictionary, updateCustomDictionary]);

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

  const emptyState = (
    <EmptyState
      icon={BookOpen}
      title={t("dictionary.emptyTitle")}
      description={t("dictionary.emptyDescription", { agentName })}
      actions={
        <>
          <Button size="sm" onClick={() => addInputRef.current?.focus()}>
            <Plus size={12} />
            {t("dictionary.addFirstWord")}
          </Button>
          <Button variant="outline-flat" size="sm" onClick={() => setShowBulkImport(true)}>
            <Upload size={11} />
            {t("dictionary.importList")}
          </Button>
        </>
      }
      className="py-8"
    />
  );

  return (
    <Tabs defaultValue="dictionary" className="flex flex-col h-full">
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t("dictionary.clearTitle")}
        description={t("dictionary.clearDescription")}
        onConfirm={() => updateCustomDictionary({ remove: userWords })}
        variant="destructive"
      />

      <div className="px-5 pt-4">
        <TabsList className="h-7 p-0.5 rounded-[7px]">
          <TabsTrigger value="dictionary" className="h-6 px-2.5 text-xs rounded-[5px]">
            {t("dictionary.tabDictionary")}
          </TabsTrigger>
          <TabsTrigger value="snippets" className="h-6 px-2.5 text-xs rounded-[5px]">
            {t("dictionary.tabSnippets")}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="dictionary" className="flex-1 min-h-0 mt-0 overflow-y-auto">
        <div className="px-5 py-4 flex flex-col gap-3">
          {/* ─── Add word ─── */}
          <div>
            <div className="relative">
              <Input
                ref={addInputRef}
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

          {/* ─── Agent name (always recognized) ─── */}
          <div className="rounded-md border border-primary/15 dark:border-primary/20 bg-primary/3 dark:bg-primary/6 px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Sparkles size={11} className="text-primary/70 shrink-0" />
              <span className="text-xs font-medium text-primary truncate">{agentName}</span>
            </div>
            <span className="text-xs text-foreground/25 shrink-0">
              {t("dictionary.agentDefault")}
            </span>
          </div>

          {/* ─── Dictionary list ─── */}
          <div className="rounded-md border border-foreground/8 dark:border-white/6 bg-foreground/[0.02] dark:bg-white/[0.03] px-4 py-3">
            {userWords.length > 0 && (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-foreground/40">
                    {t("dictionary.yourDictionary")}
                  </h3>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setConfirmClear(true)}
                      aria-label={t("dictionary.clearAll")}
                      className="text-xs text-foreground/15 hover:text-destructive/70 transition-colors"
                    >
                      {t("dictionary.clearAll")}
                    </button>
                    <button
                      onClick={handleExport}
                      aria-label={t("dictionary.exportDictionary")}
                      className="text-foreground/25 hover:text-foreground/60 transition-colors"
                    >
                      <Download size={12} />
                    </button>
                  </div>
                </div>
                <div className="mt-2.5 border-t border-dashed border-foreground/10 dark:border-white/8" />
              </>
            )}

            {userWords.length === 0 ? (
              emptyState
            ) : visibleWords.length === 0 ? (
              <EmptyState
                compact
                description={t("dictionary.noMatches", { word: newWord.trim() })}
              />
            ) : (
              <ul>
                {visibleWords.map((word) => {
                  const isEditing = editingWord === word;
                  return (
                    <li
                      key={word}
                      className="group flex items-center gap-2 h-9 border-b border-foreground/4 dark:border-white/3 last:border-b-0"
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
                        <span className="flex-1 text-xs truncate text-foreground/60">{word}</span>
                      )}
                      {!isEditing && (
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
      </TabsContent>

      <TabsContent value="snippets" className="flex-1 min-h-0 mt-0 overflow-y-auto">
        <SnippetsView />
      </TabsContent>
    </Tabs>
  );
}
