import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Plus, ChevronRight, Zap, Loader2, Check } from "lucide-react";
import { Button } from "../ui/button";
import ApiKeyInput from "../ui/ApiKeyInput";
import { cn } from "../lib/utils";
import { useSettingsStore } from "../../stores/settingsStore";
import { useNotesOnboarding } from "../../hooks/useNotesOnboarding";
import { useActions, initializeActions } from "../../stores/actionStore";
import { getProviderIcon, isMonochromeProvider } from "../../utils/providerIcons";

interface NotesOnboardingProps {
  onComplete: () => void;
  onOpenSettings?: (section: string) => void;
}

const LLM_PROVIDERS = [
  { id: "openai", name: "OpenAI", placeholder: "sk-..." },
  { id: "anthropic", name: "Anthropic", placeholder: "sk-ant-..." },
  { id: "gemini", name: "Google Gemini", placeholder: "AI..." },
] as const;

type LLMProviderId = (typeof LLM_PROVIDERS)[number]["id"];

const inputClass = cn(
  "w-full h-8 px-3 rounded-md text-xs",
  "bg-foreground/3 dark:bg-white/4 border border-border/30 dark:border-white/6",
  "text-foreground/80 placeholder:text-foreground/20 outline-none",
  "focus:border-primary/30 transition-colors duration-150"
);

export default function NotesOnboarding({ onComplete, onOpenSettings }: NotesOnboardingProps) {
  const { t } = useTranslation();
  const { isProUser, isLLMConfigured, complete } = useNotesOnboarding();
  const actions = useActions();
  const [llmExpanded, setLlmExpanded] = useState(!isLLMConfigured && !isProUser);
  const [selectedProvider, setSelectedProvider] = useState<LLMProviderId>("openai");
  const [createExpanded, setCreateExpanded] = useState(false);
  const [actionName, setActionName] = useState("");
  const [actionDescription, setActionDescription] = useState("");
  const [actionPrompt, setActionPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [justCreated, setJustCreated] = useState(false);

  const openaiApiKey = useSettingsStore((s) => s.openaiApiKey);
  const anthropicApiKey = useSettingsStore((s) => s.anthropicApiKey);
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey);
  const setOpenaiApiKey = useSettingsStore((s) => s.setOpenaiApiKey);
  const setAnthropicApiKey = useSettingsStore((s) => s.setAnthropicApiKey);
  const setGeminiApiKey = useSettingsStore((s) => s.setGeminiApiKey);
  const setReasoningProvider = useSettingsStore((s) => s.setReasoningProvider);
  const setUseReasoningModel = useSettingsStore((s) => s.setUseReasoningModel);
  const updateReasoningSettings = useSettingsStore((s) => s.updateReasoningSettings);

  useEffect(() => {
    initializeActions();
  }, []);

  const activeKey =
    selectedProvider === "openai"
      ? openaiApiKey
      : selectedProvider === "anthropic"
        ? anthropicApiKey
        : geminiApiKey;

  const setActiveKey = useCallback(
    (key: string) => {
      if (selectedProvider === "openai") setOpenaiApiKey(key);
      else if (selectedProvider === "anthropic") setAnthropicApiKey(key);
      else setGeminiApiKey(key);

      if (key) {
        setReasoningProvider(selectedProvider);
        setUseReasoningModel(true);
        updateReasoningSettings({
          useReasoningModel: true,
          reasoningProvider: selectedProvider,
          cloudReasoningMode: "byok",
        });
      }
    },
    [
      selectedProvider,
      setOpenaiApiKey,
      setAnthropicApiKey,
      setGeminiApiKey,
      setReasoningProvider,
      setUseReasoningModel,
      updateReasoningSettings,
    ]
  );

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

  const providerMeta = LLM_PROVIDERS.find((p) => p.id === selectedProvider)!;
  const builtInAction = actions.find((a) => a.is_builtin === 1);
  const customActions = actions.filter((a) => a.is_builtin !== 1);

  return (
    <div className="flex flex-col items-center justify-center h-full overflow-y-auto px-6">
      <div
        className="w-full max-w-[420px] space-y-5"
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
            {isProUser
              ? t("notes.onboarding.actions.proNote")
              : t("notes.onboarding.actions.description")}
          </p>
        </div>

        {/* LLM Configuration — non-Pro only */}
        {!isProUser && (
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

                <div className="flex items-center rounded-md border border-foreground/6 dark:border-white/6 bg-surface-1/30 dark:bg-white/[0.02] p-0.5">
                  {LLM_PROVIDERS.map((provider) => {
                    const icon = getProviderIcon(provider.id);
                    const invert = isMonochromeProvider(provider.id);
                    return (
                      <button
                        key={provider.id}
                        onClick={() => setSelectedProvider(provider.id)}
                        className={cn(
                          "flex-1 flex items-center justify-center gap-1.5 h-7 rounded text-xs font-medium transition-colors duration-150",
                          selectedProvider === provider.id
                            ? "bg-foreground/[0.06] dark:bg-white/8 text-foreground/70"
                            : "text-foreground/30 hover:text-foreground/50"
                        )}
                      >
                        {icon && (
                          <img
                            src={icon}
                            alt=""
                            className={cn("w-3.5 h-3.5", invert && "dark:invert")}
                          />
                        )}
                        {provider.name}
                      </button>
                    );
                  })}
                </div>

                <ApiKeyInput
                  apiKey={activeKey}
                  setApiKey={setActiveKey}
                  placeholder={providerMeta.placeholder}
                  label=""
                  ariaLabel={`${providerMeta.name} API key`}
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
                  {builtInAction.translation_key
                    ? t(`${builtInAction.translation_key}.name`)
                    : builtInAction.name}
                </p>
                <p className="text-xs text-foreground/25 truncate">
                  {builtInAction.translation_key
                    ? t(`${builtInAction.translation_key}.description`)
                    : builtInAction.description}
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
                className={cn(inputClass, "disabled:opacity-40")}
              />
              <input
                type="text"
                value={actionDescription}
                onChange={(e) => setActionDescription(e.target.value)}
                placeholder={t("notes.actions.descriptionPlaceholder")}
                aria-label={t("notes.actions.descriptionPlaceholder")}
                disabled={isSaving}
                className={cn(inputClass, "disabled:opacity-40")}
              />
              <textarea
                value={actionPrompt}
                onChange={(e) => setActionPrompt(e.target.value)}
                placeholder={t("notes.actions.promptPlaceholder")}
                aria-label={t("notes.actions.promptPlaceholder")}
                rows={3}
                disabled={isSaving}
                className={cn(
                  "w-full px-3 py-2 rounded-md text-xs leading-relaxed resize-none",
                  "bg-foreground/3 dark:bg-white/4 border border-border/30 dark:border-white/6",
                  "text-foreground/80 placeholder:text-foreground/20 outline-none",
                  "focus:border-primary/30 transition-colors duration-150",
                  "disabled:opacity-40"
                )}
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

        {/* Pro upsell — non-Pro only */}
        {!isProUser && (
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg bg-primary/[0.04] dark:bg-primary/[0.06] border border-primary/10 dark:border-primary/15">
            <p className="text-xs text-primary/50 leading-relaxed flex-1">
              {t("notes.onboarding.proUpsell.message")}
            </p>
            {onOpenSettings && (
              <button
                type="button"
                onClick={() => onOpenSettings("plansBilling")}
                className="text-xs font-medium text-primary/60 hover:text-primary/80 transition-colors whitespace-nowrap"
              >
                {t("notes.onboarding.proUpsell.learnMore")}
              </button>
            )}
          </div>
        )}

        <div className="flex justify-center pt-1 pb-4">
          <Button variant="default" size="sm" onClick={handleComplete} className="h-8 text-xs px-8">
            {t("notes.onboarding.getStarted")}
          </Button>
        </div>
      </div>
    </div>
  );
}
