import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CornerDownLeft,
  Download,
  NotebookPen,
  PanelRight,
  Pencil,
  Plus,
  Sparkles,
  Upload,
  X,
} from "./icons";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { PAGE_CONTENT_WIDTH_CLASS } from "./ui/pageWidth";
import { cn } from "./lib/utils";
import { ConfirmDialog } from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { useToast } from "./ui/useToast";
import SnippetsView from "./SnippetsView";
import DictionaryEmptyIllustration from "./DictionaryEmptyIllustration";
import { useSettings } from "../hooks/useSettings";
import { getAgentName } from "../utils/agentName";
import { parseDictionaryImportText } from "../helpers/dictionaryImport";
import { getDictionaryHintWords } from "../utils/snippets";
import { WHISPER_DECODER_PROMPT_CHARS } from "../utils/dictionaryPromptCap";

export default function DictionaryView() {
  const { t } = useTranslation();
  const { customDictionary, updateCustomDictionary, snippets } = useSettings();
  const agentName = getAgentName();
  const { toast } = useToast();

  const [newWord, setNewWord] = useState("");
  const [showEmptyInput, setShowEmptyInput] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [editingWord, setEditingWord] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);

  const pendingImportCount = useMemo(() => parseDictionaryImportText(bulkText).length, [bulkText]);

  // Length of the prompt string the STT request builds (words + snippet
  // triggers, comma-joined), so the warning fires on real request size. A
  // Chinese script bias adds ~21 chars on top for zh-CN / zh-TW users.
  const promptChars = useMemo(
    () => getDictionaryHintWords({ customDictionary, snippets }).join(", ").length,
    [customDictionary, snippets]
  );

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
    if (addWords(newWord) > 0) {
      setNewWord("");
      setShowEmptyInput(false);
    }
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

  const addWordInput = (
    <div className="relative">
      <Input
        dir="auto"
        autoFocus={userWords.length === 0}
        placeholder={t("dictionary.addPlaceholder")}
        value={newWord}
        onChange={(e) => setNewWord(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") handleAdd();
          if (e.key === "Escape" && userWords.length === 0) setShowEmptyInput(false);
        }}
        className="h-10 w-full rounded-full! pe-24 text-sm placeholder:text-foreground/45"
      />
      <div className="absolute end-3 top-1/2 flex -translate-y-1/2 items-center gap-2">
        <button
          onClick={handleAdd}
          disabled={!newWord.trim()}
          aria-label={t("dictionary.addWord")}
          className="flex items-center gap-1 text-xs text-foreground/45 transition-colors enabled:hover:text-primary disabled:text-foreground/45"
        >
          {t("dictionary.add")}
          <CornerDownLeft size={12} />
        </button>
        <div className="h-4 w-px bg-foreground/10 dark:bg-white/8" />
        <button
          onClick={() => setShowBulkImport(true)}
          aria-label={t("dictionary.importWords")}
          className="text-foreground/45 transition-colors hover:text-foreground/60"
        >
          <Upload size={14} />
        </button>
      </div>
    </div>
  );

  const emptyState = (
    <div className="flex min-h-64 items-start px-6 py-6">
      <div className="relative z-10 w-full min-w-0 md:w-3/5">
        <h2 className="text-xl font-normal text-foreground">{t("dictionary.emptyTitle")}</h2>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-foreground/50 dark:text-foreground/65">
          {t("dictionary.emptyDescription", { agentName })}
        </p>
        {showEmptyInput ? (
          <div className="mt-6 max-w-md">{addWordInput}</div>
        ) : (
          <Button className="mt-6 px-5 font-normal" onClick={() => setShowEmptyInput(true)}>
            <Plus size={16} />
            {t("dictionary.addFirstWord")}
          </Button>
        )}
      </div>
      <DictionaryEmptyIllustration variant="dictionary" />
    </div>
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

      <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "max-w-7xl px-6 pt-6")}>
        <TabsList className="h-10 rounded-full p-1">
          <TabsTrigger value="dictionary" className="h-8 gap-2 rounded-full px-4 text-sm">
            <NotebookPen size={17} />
            {t("dictionary.tabDictionary")}
          </TabsTrigger>
          <TabsTrigger value="snippets" className="h-8 gap-2 rounded-full px-4 text-sm">
            <PanelRight size={17} />
            {t("dictionary.tabSnippets")}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="dictionary" className="flex-1 min-h-0 mt-0 overflow-y-auto">
        <div className={cn(PAGE_CONTENT_WIDTH_CLASS, "max-w-7xl flex flex-col gap-3 px-6 py-5")}>
          {/* ─── Add word ─── */}
          {userWords.length > 0 && addWordInput}

          {/* ─── Bulk import ─── */}
          {showBulkImport && (
            <div className="rounded-md border border-primary/30 dark:border-primary/40 px-3 pt-2.5 pb-2">
              <Textarea
                dir="auto"
                autoFocus
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={t("dictionary.importPlaceholder")}
                rows={4}
                className="min-h-[72px] resize-none border-0 shadow-none rounded-none bg-transparent p-0 text-xs text-foreground placeholder:text-foreground/45 hover:border-0 focus:border-0 focus:ring-0"
              />
              <div className="flex items-center justify-between pt-1.5">
                <p className="text-xs text-foreground/45">
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
          {userWords.length > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/15 bg-primary/3 px-4 py-3 dark:border-primary/20 dark:bg-primary/6">
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles size={11} className="text-primary/70 shrink-0" />
                <span dir="auto" className="text-xs font-medium text-primary truncate">
                  {agentName}
                </span>
              </div>
              <span className="text-xs text-foreground/45 shrink-0">
                {t("dictionary.agentDefault")}
              </span>
            </div>
          )}

          {/* ─── Dictionary list ─── */}
          <div
            className={cn(
              "border border-border/70 bg-card/50 shadow-sm dark:border-white/10 dark:bg-surface-2/60",
              userWords.length > 0
                ? "rounded-2xl px-4 py-3"
                : "relative overflow-hidden rounded-3xl dark:bg-surface-window"
            )}
          >
            {userWords.length > 0 && (
              <>
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-semibold text-foreground/45">
                    {t("dictionary.yourDictionary")}
                  </h3>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setConfirmClear(true)}
                      aria-label={t("dictionary.clearAll")}
                      className="text-xs text-foreground/45 hover:text-destructive/70 transition-colors"
                    >
                      {t("dictionary.clearAll")}
                    </button>
                    <button
                      onClick={handleExport}
                      aria-label={t("dictionary.exportDictionary")}
                      className="text-foreground/45 hover:text-foreground/60 transition-colors"
                    >
                      <Download size={12} />
                    </button>
                  </div>
                </div>
                <div className="mt-2.5 border-t border-dashed border-foreground/10 dark:border-white/10" />
              </>
            )}

            {userWords.length === 0 ? (
              emptyState
            ) : visibleWords.length === 0 ? (
              <p className="py-6 text-xs text-foreground/45 text-center">
                {t("dictionary.noMatches", { word: newWord.trim() })}
              </p>
            ) : (
              <ul>
                {visibleWords.map((word) => {
                  const isEditing = editingWord === word;
                  return (
                    <li
                      key={word}
                      className="group flex items-center gap-2 h-9 border-b border-foreground/4 dark:border-white/10 last:border-b-0"
                    >
                      {isEditing ? (
                        <Input
                          dir="auto"
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
                        <span dir="auto" className="flex-1 text-xs truncate text-foreground/60">
                          {word}
                        </span>
                      )}
                      {!isEditing && (
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
                          <button
                            onClick={() => startEdit(word)}
                            aria-label={t("dictionary.editWord", { word })}
                            className="p-1 text-foreground/45 hover:text-foreground/60 transition-colors"
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            onClick={() => handleRemove(word)}
                            aria-label={t("dictionary.removeWord", { word })}
                            className="p-1 text-foreground/45 hover:text-destructive/70 transition-colors"
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

          {/* ─── Provider prompt-limit notice ─── */}
          {promptChars > WHISPER_DECODER_PROMPT_CHARS && (
            <p className="text-xs text-foreground/45 leading-relaxed">
              {t("dictionary.promptLimitNotice", { chars: promptChars })}
            </p>
          )}
        </div>
      </TabsContent>

      <TabsContent value="snippets" className="flex-1 min-h-0 mt-0 overflow-y-auto">
        <SnippetsView />
      </TabsContent>
    </Tabs>
  );
}
