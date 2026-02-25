import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Plus, ChevronRight, Zap, Loader2, Check } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import { useNotesOnboarding } from "../../hooks/useNotesOnboarding";
import {
  useActions,
  initializeActions,
  getActionName,
  getActionDescription,
} from "../../stores/actionStore";
import { notesInputClass, notesTextareaClass } from "./shared";
import { useDialogs } from "../../hooks/useDialogs";
import { AlertDialog } from "../ui/dialog";
import ReasoningModelSelector from "../ReasoningModelSelector";

interface NotesOnboardingProps {
  onComplete: () => void;
}

export default function NotesOnboarding({ onComplete }: NotesOnboardingProps) {
  const { t } = useTranslation();
  const { isProUser, isProLoading, isLLMConfigured, complete } = useNotesOnboarding();
  const actions = useActions();
  const [llmExpanded, setLlmExpanded] = useState(!isLLMConfigured && !isProUser);
  const [createExpanded, setCreateExpanded] = useState(false);
  const [actionName, setActionName] = useState("");
  const [actionDescription, setActionDescription] = useState("");
  const [actionPrompt, setActionPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [justCreated, setJustCreated] = useState(false);

  const reasoningModel = useSettingsStore((s) => s.reasoningModel);
  const setReasoningModel = useSettingsStore((s) => s.setReasoningModel);
  const reasoningProvider = useSettingsStore((s) => s.reasoningProvider);
  const setReasoningProvider = useSettingsStore((s) => s.setReasoningProvider);
  const cloudReasoningBaseUrl = useSettingsStore((s) => s.cloudReasoningBaseUrl);
  const setCloudReasoningBaseUrl = useSettingsStore((s) => s.setCloudReasoningBaseUrl);
  const openaiApiKey = useSettingsStore((s) => s.openaiApiKey);
  const setOpenaiApiKey = useSettingsStore((s) => s.setOpenaiApiKey);
  const anthropicApiKey = useSettingsStore((s) => s.anthropicApiKey);
  const setAnthropicApiKey = useSettingsStore((s) => s.setAnthropicApiKey);
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey);
  const setGeminiApiKey = useSettingsStore((s) => s.setGeminiApiKey);
  const groqApiKey = useSettingsStore((s) => s.groqApiKey);
  const setGroqApiKey = useSettingsStore((s) => s.setGroqApiKey);
  const customReasoningApiKey = useSettingsStore((s) => s.customReasoningApiKey);
  const setCustomReasoningApiKey = useSettingsStore((s) => s.setCustomReasoningApiKey);

  const { alertDialog, hideAlertDialog } = useDialogs();

  useEffect(() => {
    initializeActions();
  }, []);

  const handleCreateAction = async () => {
    if (!actionName.trim() || !actionPrompt.trim()) return;
    setIsSaving(true);
    try {
      await window.electronAPI.createAction(
        actionName.trim(),
        actionDescription.trim(),
        actionPrompt.trim()
      );
      setActionName("");
      setActionDescription("");
      setActionPrompt("");
      setJustCreated(true);
      setTimeout(() => setJustCreated(false), 2000);
    } finally {
      setIsSaving(false);
    }
  };

  const handleComplete = () => {
    complete();
    onComplete();
  };

  const builtInAction = actions.find((a) => a.is_builtin === 1);
  const customActions = actions.filter((a) => a.is_builtin !== 1);

  return (
    <div className="flex flex-col items-center h-full overflow-y-auto px-6 py-6">
      <div
        className="w-full max-w-[420px] space-y-5 my-auto"
        style={{ animation: "float-up 0.4s ease-out" }}
      >
        <div className="flex flex-col items-center text-center">
          <div className="w-10 h-10 rounded-[10px] bg-gradient-to-b from-accent/10 to-accent/[0.03] dark:from-accent/15 dark:to-accent/5 border border-accent/15 dark:border-accent/20 flex items-center justify-center mb-3">
            <Sparkles size={17} strokeWidth={1.5} className="text-accent/60" />
          </div>
          <h2 className="text-sm font-semibold text-foreground mb-1">
            {t("notes.onboarding.actions.title")}
          </h2>
          <p className="text-xs text-foreground/35 leading-relaxed max-w-[320px]">
            {t("notes.onboarding.actions.description")}
          </p>
        </div>

        {/* LLM Configuration — non-Pro only, deferred until pro status is known */}
        {!isProLoading && !isProUser && (
          <div
            className={cn(
              "rounded-lg border transition-colors duration-200",
              isLLMConfigured
                ? "border-success/20 bg-success/[0.03]"
                : "border-foreground/8 dark:border-white/6 bg-surface-1/30 dark:bg-white/[0.02]"
            )}
          >
            <button
              type="button"
              onClick={() => setLlmExpanded(!llmExpanded)}
              aria-expanded={llmExpanded}
              className="flex items-center justify-between w-full px-4 py-3 text-left"
            >
              <div className="flex items-center gap-2.5">
                <Zap
                  size={13}
                  className={cn(isLLMConfigured ? "text-success/60" : "text-foreground/30")}
                />
                <span className="text-xs font-medium text-foreground/70">
                  {t("notes.onboarding.llm.title")}
                </span>
                {isLLMConfigured && (
                  <span className="text-xs text-success/60 font-medium">
                    {t("notes.onboarding.llm.configured")}
                  </span>
                )}
              </div>
              <ChevronRight
                size={12}
                className={cn(
                  "text-foreground/20 transition-transform duration-200",
                  llmExpanded && "rotate-90"
                )}
              />
            </button>

            {llmExpanded && (
              <div className="px-4 pb-4 space-y-3" style={{ animation: "float-up 0.2s ease-out" }}>
                <p className="text-xs text-foreground/30 leading-relaxed">
                  {t("notes.onboarding.llm.description")}
                </p>

                <ReasoningModelSelector
                  reasoningModel={reasoningModel}
                  setReasoningModel={setReasoningModel}
                  localReasoningProvider={reasoningProvider}
                  setLocalReasoningProvider={setReasoningProvider}
                  cloudReasoningBaseUrl={cloudReasoningBaseUrl}
                  setCloudReasoningBaseUrl={setCloudReasoningBaseUrl}
                  openaiApiKey={openaiApiKey}
                  setOpenaiApiKey={setOpenaiApiKey}
                  anthropicApiKey={anthropicApiKey}
                  setAnthropicApiKey={setAnthropicApiKey}
                  geminiApiKey={geminiApiKey}
                  setGeminiApiKey={setGeminiApiKey}
                  groqApiKey={groqApiKey}
                  setGroqApiKey={setGroqApiKey}
                  customReasoningApiKey={customReasoningApiKey}
                  setCustomReasoningApiKey={setCustomReasoningApiKey}
                />
              </div>
            )}
          </div>
        )}

        {/* Built-in action */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-medium text-foreground/50">
              {t("notes.onboarding.actions.builtInLabel")}
            </span>
          </div>
          {builtInAction && (
            <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-foreground/6 dark:border-white/6 bg-surface-1/20 dark:bg-white/[0.02]">
              <div className="w-7 h-7 rounded-md bg-accent/8 dark:bg-accent/12 border border-accent/10 dark:border-accent/15 flex items-center justify-center shrink-0">
                <Sparkles size={12} className="text-accent/60" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground/70 truncate">
                  {getActionName(builtInAction, t)}
                </p>
                <p className="text-xs text-foreground/25 truncate">
                  {getActionDescription(builtInAction, t)}
                </p>
              </div>
              <span className="text-xs text-foreground/15 font-medium shrink-0">
                {t("notes.actions.builtIn")}
              </span>
            </div>
          )}

          {/* Show any custom actions the user just created */}
          {customActions.length > 0 && (
            <div className="mt-1.5 space-y-1.5">
              {customActions.map((action) => (
                <div
                  key={action.id}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-success/20 bg-success/[0.03]"
                >
                  <div className="w-7 h-7 rounded-md bg-success/8 border border-success/15 dark:border-success/20 flex items-center justify-center shrink-0">
                    <Check size={12} className="text-success/60" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground/70 truncate">{action.name}</p>
                    {action.description && (
                      <p className="text-xs text-foreground/25 truncate">{action.description}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Create custom action */}
        <div
          className={cn(
            "rounded-lg border transition-colors duration-200",
            "border-foreground/8 dark:border-white/6 bg-surface-1/30 dark:bg-white/[0.02]"
          )}
        >
          <button
            type="button"
            onClick={() => setCreateExpanded(!createExpanded)}
            aria-expanded={createExpanded}
            className="flex items-center justify-between w-full px-4 py-3 text-left"
          >
            <div className="flex items-center gap-2.5">
              <Plus size={13} className="text-foreground/30" />
              <span className="text-xs font-medium text-foreground/70">
                {t("notes.onboarding.actions.createTitle")}
              </span>
              {justCreated && (
                <span className="text-xs text-success/60 font-medium">
                  {t("notes.onboarding.actions.created")}
                </span>
              )}
            </div>
            <ChevronRight
              size={12}
              className={cn(
                "text-foreground/20 transition-transform duration-200",
                createExpanded && "rotate-90"
              )}
            />
          </button>

          {createExpanded && (
            <div className="px-4 pb-4 space-y-2" style={{ animation: "float-up 0.2s ease-out" }}>
              <p className="text-xs text-foreground/30 leading-relaxed">
                {t("notes.onboarding.actions.createDescription")}
              </p>
              <input
                type="text"
                value={actionName}
                onChange={(e) => setActionName(e.target.value)}
                placeholder={t("notes.actions.namePlaceholder")}
                aria-label={t("notes.actions.namePlaceholder")}
                disabled={isSaving}
                className={cn(notesInputClass, "disabled:opacity-40")}
              />
              <input
                type="text"
                value={actionDescription}
                onChange={(e) => setActionDescription(e.target.value)}
                placeholder={t("notes.actions.descriptionPlaceholder")}
                aria-label={t("notes.actions.descriptionPlaceholder")}
                disabled={isSaving}
                className={cn(notesInputClass, "disabled:opacity-40")}
              />
              <textarea
                value={actionPrompt}
                onChange={(e) => setActionPrompt(e.target.value)}
                placeholder={t("notes.actions.promptPlaceholder")}
                aria-label={t("notes.actions.promptPlaceholder")}
                rows={3}
                disabled={isSaving}
                className={cn(notesTextareaClass, "disabled:opacity-40")}
              />
              <div className="flex justify-end">
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleCreateAction}
                  disabled={isSaving || !actionName.trim() || !actionPrompt.trim()}
                  className="h-7 text-xs"
                >
                  {isSaving ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    t("notes.actions.save")
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-center pt-1 pb-4">
          <Button variant="default" size="sm" onClick={handleComplete} className="h-8 text-xs px-8">
            {t("notes.onboarding.getStarted")}
          </Button>
        </div>
      </div>

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={hideAlertDialog}
      />
    </div>
  );
}
