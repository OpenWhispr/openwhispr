import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, X, CornerDownLeft, Info, Upload, Sparkles, Loader2 } from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  ConfirmDialog,
} from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { useSettings } from "../hooks/useSettings";
import { getAgentName } from "../utils/agentName";
import ReasoningService from "../services/ReasoningService";
import { useSettingsStore } from "../stores/settingsStore";

export default function DictionaryView() {
  const { t } = useTranslation();
  const { customDictionary, setCustomDictionary } = useSettings();
  const agentName = getAgentName();
  const [newWord, setNewWord] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");

  const isEmpty = customDictionary.length === 0;

  const handleAdd = useCallback(() => {
    const words = newWord
      .split(",")
      .map((w) => w.trim())
      .filter((w) => w && !customDictionary.includes(w));
    if (words.length > 0) {
      setCustomDictionary([...customDictionary, ...words]);
      setNewWord("");
    }
  }, [newWord, customDictionary, setCustomDictionary]);

  const handleRemove = useCallback(
    (word: string) => {
      if (word === agentName) return;
      setCustomDictionary(customDictionary.filter((w) => w !== word));
    },
    [customDictionary, setCustomDictionary, agentName]
  );

  /** Parse pasted text: split by lines first, then by comma/semicolon
   *  within each line.  This preserves terms like "Vue.js" and ".tsx"
   *  because the dot is never used as a separator. */
  const parseWordList = (text: string): string[] => {
    return text
      .split(/\r?\n/)
      .flatMap((line) => line.split(/[,;]/))
      .map((w) => w.trim())
      .filter((w) => w.length > 0);
  };

  const handleImport = useCallback(() => {
    const existing = new Set(customDictionary.map((w) => w.toLowerCase()));
    const words = parseWordList(importText).filter((w) => {
      const norm = w.toLowerCase();
      if (existing.has(norm)) return false;
      existing.add(norm);
      return true;
    });
    if (words.length > 0) {
      setCustomDictionary([...customDictionary, ...words]);
    }
    setImportText("");
    setShowImport(false);
  }, [importText, customDictionary, setCustomDictionary]);

  const importWordCount = parseWordList(importText).length;

  /* ─── AI extraction state ─── */
  const [extractText, setExtractText] = useState("");
  const [extractedWords, setExtractedWords] = useState<string[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [importTab, setImportTab] = useState("list");
  const reasoningModel = useSettingsStore((s) => s.reasoningModel);

  const handleExtract = useCallback(async () => {
    if (!extractText.trim() || isExtracting) return;
    setIsExtracting(true);
    setExtractError("");
    setExtractedWords([]);

    try {
      const result = await ReasoningService.processText(extractText, reasoningModel, null, {
        systemPrompt:
          "You are a dictionary term extractor for a speech recognition system. " +
          "Extract ONLY individual words or short compound terms (1-3 words maximum) that a speech-to-text engine might misspell or fail to recognize. " +
          "Focus on: proper nouns, brand names, product names, technical abbreviations, acronyms, domain-specific jargon, unusual spellings, foreign words. " +
          "NEVER return full sentences, phrases longer than 3 words, or common everyday words. " +
          "Each term must be a single concept — not a description or explanation. " +
          "Return ONLY a comma-separated list. No explanations, no numbering, no categories, no quotes. " +
          "Example input: 'We deployed the app on Kubernetes using gRPC and PostgreSQL with OAuth2 authentication.' " +
          "Example output: Kubernetes, gRPC, PostgreSQL, OAuth2",
        temperature: 0.1,
        maxTokens: 1024,
      });

      const words = result
        .split(/[,\n]/)
        .map((w) => w.trim().replace(/^[-•*\d.)\s]+/, "").replace(/^["']|["']$/g, ""))
        .filter((w) => {
          if (w.length === 0 || w.length > 50) return false;
          // Reject anything with more than 3 words (likely a sentence/phrase)
          const wordCount = w.split(/\s+/).length;
          if (wordCount > 3) return false;
          return true;
        });

      if (words.length === 0) {
        setExtractError(t("dictionary.extractEmpty"));
      } else {
        setExtractedWords(words);
      }
    } catch (err: any) {
      setExtractError(err?.message || t("dictionary.extractError"));
    } finally {
      setIsExtracting(false);
    }
  }, [extractText, reasoningModel, isExtracting, t]);

  const handleImportExtracted = useCallback(() => {
    const existing = new Set(customDictionary.map((w) => w.toLowerCase()));
    const words = extractedWords.filter((w) => {
      const norm = w.toLowerCase();
      if (existing.has(norm)) return false;
      existing.add(norm);
      return true;
    });
    if (words.length > 0) {
      setCustomDictionary([...customDictionary, ...words]);
    }
    setExtractText("");
    setExtractedWords([]);
    setExtractError("");
    setShowImport(false);
    setImportTab("list");
  }, [extractedWords, customDictionary, setCustomDictionary]);

  const resetImportDialog = useCallback(() => {
    setImportText("");
    setExtractText("");
    setExtractedWords([]);
    setExtractError("");
    setImportTab("list");
  }, []);

  return (
    <div className="flex flex-col h-full">
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t("dictionary.clearTitle")}
        description={t("dictionary.clearDescription")}
        onConfirm={() => setCustomDictionary(customDictionary.filter((w) => w === agentName))}
        variant="destructive"
      />

      <Dialog open={showImport} onOpenChange={(open) => { setShowImport(open); if (!open) resetImportDialog(); }}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{t("dictionary.importTitle")}</DialogTitle>
          </DialogHeader>
          <Tabs value={importTab} onValueChange={setImportTab}>
            <TabsList className="w-full">
              <TabsTrigger value="list" className="flex-1 gap-1.5">
                <Upload size={12} />
                {t("dictionary.tabList")}
              </TabsTrigger>
              <TabsTrigger value="extract" className="flex-1 gap-1.5">
                <Sparkles size={12} />
                {t("dictionary.tabExtract")}
              </TabsTrigger>
            </TabsList>

            {/* ─── List tab (existing) ─── */}
            <TabsContent value="list">
              <DialogDescription className="mb-2">{t("dictionary.importDescription")}</DialogDescription>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={t("dictionary.importPlaceholder")}
                className="w-full h-40 rounded-lg border border-border/40 dark:border-white/8 bg-foreground/[0.02] dark:bg-white/[0.03] px-3 py-2.5 text-xs text-foreground placeholder:text-foreground/20 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none font-mono"
              />
              {importWordCount > 0 && (
                <p className="text-xs text-foreground/30 mt-1.5">
                  {t("dictionary.importCount", { count: importWordCount })}
                </p>
              )}
              <DialogFooter className="mt-3">
                <Button variant="outline" size="sm" onClick={() => { setShowImport(false); resetImportDialog(); }}>
                  {t("dictionary.importCancel")}
                </Button>
                <Button size="sm" onClick={handleImport} disabled={importWordCount === 0}>
                  {t("dictionary.importConfirm")}
                </Button>
              </DialogFooter>
            </TabsContent>

            {/* ─── Extract tab (AI) ─── */}
            <TabsContent value="extract">
              <DialogDescription className="mb-2">{t("dictionary.extractDescription")}</DialogDescription>
              <textarea
                value={extractText}
                onChange={(e) => { setExtractText(e.target.value); setExtractedWords([]); setExtractError(""); }}
                placeholder={t("dictionary.extractPlaceholder")}
                className="w-full h-32 rounded-lg border border-border/40 dark:border-white/8 bg-foreground/[0.02] dark:bg-white/[0.03] px-3 py-2.5 text-xs text-foreground placeholder:text-foreground/20 focus:outline-none focus:ring-1 focus:ring-primary/30 resize-none"
                disabled={isExtracting}
              />

              {extractError && (
                <p className="text-xs text-destructive mt-1.5">{extractError}</p>
              )}

              {extractedWords.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs text-foreground/30 mb-1.5">
                    {t("dictionary.extractCount", { count: extractedWords.length })}
                  </p>
                  <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto p-2 rounded-md bg-foreground/[0.02] dark:bg-white/[0.02] border border-foreground/5 dark:border-white/4">
                    {extractedWords.map((word) => (
                      <span
                        key={word}
                        className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-[5px] text-xs bg-primary/8 dark:bg-primary/12 text-foreground/60 border border-primary/15"
                      >
                        {word}
                        <button
                          onClick={() => setExtractedWords((prev) => prev.filter((w) => w !== word))}
                          className="p-0.5 rounded-sm text-foreground/25 hover:text-destructive/70 transition-colors"
                        >
                          <X size={9} strokeWidth={2} />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <DialogFooter className="mt-3">
                <Button variant="outline" size="sm" onClick={() => { setShowImport(false); resetImportDialog(); }}>
                  {t("dictionary.importCancel")}
                </Button>
                {extractedWords.length > 0 ? (
                  <Button size="sm" onClick={handleImportExtracted}>
                    {t("dictionary.importConfirm")} ({extractedWords.length})
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={handleExtract}
                    disabled={!extractText.trim() || isExtracting || !reasoningModel}
                  >
                    {isExtracting ? (
                      <>
                        <Loader2 size={12} className="animate-spin mr-1" />
                        {t("dictionary.extracting")}
                      </>
                    ) : (
                      <>
                        <Sparkles size={12} className="mr-1" />
                        {t("dictionary.extractButton")}
                      </>
                    )}
                  </Button>
                )}
              </DialogFooter>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {isEmpty ? (
        /* ─── Empty state ─── */
        <div className="flex-1 flex flex-col items-center justify-center px-8 -mt-4">
          <div className="w-10 h-10 rounded-[10px] bg-gradient-to-b from-primary/8 to-primary/4 dark:from-primary/12 dark:to-primary/6 border border-primary/10 dark:border-primary/15 flex items-center justify-center mb-4">
            <BookOpen
              size={17}
              strokeWidth={1.5}
              className="text-primary/50 dark:text-primary/60"
            />
          </div>

          <h2 className="text-xs font-semibold text-foreground mb-1">{t("dictionary.title")}</h2>
          <p className="text-xs text-foreground/30 text-center leading-relaxed max-w-[240px] mb-6">
            {t("dictionary.description")}
          </p>

          <div className="w-full max-w-[260px] relative">
            <Input
              placeholder={t("dictionary.addPlaceholder")}
              value={newWord}
              onChange={(e) => setNewWord(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAdd();
              }}
              className="w-full h-8 text-xs pr-8 placeholder:text-foreground/20"
            />
            {newWord.trim() ? (
              <button
                onClick={handleAdd}
                aria-label={t("dictionary.addWord")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-primary/50 hover:text-primary transition-colors"
              >
                <CornerDownLeft size={11} />
              </button>
            ) : (
              <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-foreground/12 font-mono select-none pointer-events-none">
                ⏎
              </kbd>
            )}
          </div>

          <div className="flex items-center gap-1.5 mt-3">
            {["OpenWhispr", "Dr. Smith", "gRPC"].map((ex) => (
              <span
                key={ex}
                className="text-xs text-foreground/12 px-1.5 py-0.5 rounded-[4px] border border-dashed border-foreground/6 dark:border-white/5"
              >
                {ex}
              </span>
            ))}
          </div>

          <button
            onClick={() => setShowImport(true)}
            className="mt-5 flex items-center gap-1.5 text-xs text-foreground/20 hover:text-primary/60 transition-colors"
          >
            <Upload size={11} />
            {t("dictionary.importButton")}
          </button>

          <div className="mt-5 w-full max-w-[260px]">
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
                  {t("dictionary.howItWorksDetail")}
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
              <h2 className="text-xs font-semibold text-foreground">{t("dictionary.title")}</h2>
              <span className="text-xs text-foreground/15 font-mono tabular-nums">
                {customDictionary.length}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowImport(true)}
                className="text-xs text-foreground/15 hover:text-primary/70 transition-colors flex items-center gap-1"
              >
                <Upload size={10} />
                {t("dictionary.importButton")}
              </button>
              <button
                onClick={() => setConfirmClear(true)}
                aria-label={t("dictionary.clearAll")}
                className="text-xs text-foreground/15 hover:text-destructive/70 transition-colors"
              >
                {t("dictionary.clearAll")}
              </button>
            </div>
          </div>

          <div className="px-5 pb-3">
            <div className="relative">
              <Input
                placeholder={t("dictionary.addPlaceholder")}
                value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAdd();
                }}
                className="w-full h-7 text-xs pr-8 placeholder:text-foreground/20"
              />
              {newWord.trim() ? (
                <button
                  onClick={handleAdd}
                  aria-label={t("dictionary.addWord")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-primary/50 hover:text-primary transition-colors"
                >
                  <CornerDownLeft size={10} />
                </button>
              ) : (
                <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-foreground/12 font-mono select-none pointer-events-none">
                  ⏎
                </kbd>
              )}
            </div>
          </div>

          <div className="mx-5 h-px bg-border/8 dark:bg-white/3" />

          <div className="flex-1 overflow-y-auto px-5 py-3">
            <div className="flex flex-wrap gap-1.5">
              {customDictionary.map((word) => {
                const isAgentName = word === agentName;
                return (
                  <span
                    key={word}
                    className={`group inline-flex items-center gap-1 py-[3px]
                      rounded-[5px] text-xs
                      border transition-colors duration-150
                      ${
                        isAgentName
                          ? "pl-2.5 pr-2.5 bg-primary/10 dark:bg-primary/15 text-primary border-primary/20 dark:border-primary/30"
                          : "pl-2.5 pr-1 bg-foreground/[0.02] dark:bg-white/[0.03] text-foreground/60 dark:text-foreground/50 border-foreground/8 dark:border-white/6 hover:border-foreground/15 dark:hover:border-white/12 hover:bg-foreground/[0.04] dark:hover:bg-white/[0.06] hover:text-foreground/80 dark:hover:text-foreground/70"
                      }`}
                    title={isAgentName ? t("dictionary.autoManaged") : undefined}
                  >
                    {word}
                    {!isAgentName && (
                      <button
                        onClick={() => handleRemove(word)}
                        aria-label={t("dictionary.removeWord", { word })}
                        className="p-0.5 rounded-sm
                          opacity-0 group-hover:opacity-100
                          text-foreground/25 hover:!text-destructive/70
                          transition-colors duration-150"
                      >
                        <X size={10} strokeWidth={2} />
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="px-5 pb-3 flex items-start gap-1.5">
            <Info size={9} className="text-foreground/10 mt-px shrink-0" />
            <p className="text-xs text-foreground/12 leading-relaxed">
              {t("dictionary.inputHint")}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
