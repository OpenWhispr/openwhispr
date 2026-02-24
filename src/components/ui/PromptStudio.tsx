import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { Textarea } from "./textarea";
import {
  Eye,
  Edit3,
  Play,
  Save,
  RotateCcw,
  Copy,
  TestTube,
  AlertTriangle,
  Check,
} from "lucide-react";
import { AlertDialog } from "./dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { useAgentName } from "../../utils/agentName";
import ReasoningService from "../../services/ReasoningService";
import { getModelProvider } from "../../models/ModelRegistry";
import logger from "../../utils/logger";
import {
  UNIFIED_SYSTEM_PROMPT,
  LEGACY_PROMPTS,
  PROMPT_MODES,
  type PromptMode,
  getPromptMode,
  setPromptMode,
  getCustomUnifiedPrompt,
  getLegacyPrompts,
  hasCustomLegacyPrompts,
} from "../../config/prompts";
import { useSettingsStore, selectIsCloudReasoningMode } from "../../stores/settingsStore";

interface PromptStudioProps {
  className?: string;
}

type ProviderConfig = {
  label: string;
  apiKeyStorageKey?: string;
  baseStorageKey?: string;
};

const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  openai: { label: "OpenAI", apiKeyStorageKey: "openaiApiKey" },
  anthropic: { label: "Anthropic", apiKeyStorageKey: "anthropicApiKey" },
  gemini: { label: "Gemini", apiKeyStorageKey: "geminiApiKey" },
  groq: { label: "Groq", apiKeyStorageKey: "groqApiKey" },
  openwhispr: { label: "OpenWhispr Cloud" },
  custom: {
    label: "Custom endpoint",
    apiKeyStorageKey: "openaiApiKey",
    baseStorageKey: "cloudReasoningBaseUrl",
  },
  local: { label: "Local" },
};

function getCurrentUnifiedPrompt(): string {
  return getCustomUnifiedPrompt() || UNIFIED_SYSTEM_PROMPT;
}

export default function PromptStudio({ className = "" }: PromptStudioProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"current" | "edit" | "test">("current");
  const [promptMode, setPromptModeState] = useState<PromptMode>(PROMPT_MODES.UNIFIED);
  const [editedUnifiedPrompt, setEditedUnifiedPrompt] = useState(UNIFIED_SYSTEM_PROMPT);
  const [editedAgentPrompt, setEditedAgentPrompt] = useState(LEGACY_PROMPTS.agent);
  const [editedRegularPrompt, setEditedRegularPrompt] = useState(LEGACY_PROMPTS.regular);
  const [testText, setTestText] = useState(() => t("promptStudio.defaultTestInput"));
  const [testResult, setTestResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const { alertDialog, showAlertDialog, hideAlertDialog } = useDialogs();
  const { agentName } = useAgentName();

  const effectiveModel = useSettingsStore((s) => s.reasoningModel);
  const isCloudMode = useSettingsStore(selectIsCloudReasoningMode);
  const useReasoningModel = useSettingsStore((s) => s.useReasoningModel);
  const reasoningModel = useSettingsStore((s) => s.reasoningModel);

  useEffect(() => {
    setPromptModeState(getPromptMode());

    const unifiedPrompt = getCustomUnifiedPrompt();
    if (unifiedPrompt) {
      setEditedUnifiedPrompt(unifiedPrompt);
    }

    const legacyPrompts = getLegacyPrompts();
    setEditedAgentPrompt(legacyPrompts.agent);
    setEditedRegularPrompt(legacyPrompts.regular);
  }, []);

  const savePrompt = () => {
    setPromptMode(promptMode);

    if (promptMode === PROMPT_MODES.UNIFIED) {
      localStorage.setItem("customUnifiedPrompt", JSON.stringify(editedUnifiedPrompt));
    } else {
      localStorage.setItem(
        "customPrompts",
        JSON.stringify({
          agent: editedAgentPrompt,
          regular: editedRegularPrompt,
        })
      );
    }

    showAlertDialog({
      title: t("promptStudio.dialogs.saved.title"),
      description:
        promptMode === PROMPT_MODES.UNIFIED
          ? t("promptStudio.dialogs.saved.description")
          : t("promptStudio.dialogs.saved.descriptionLegacy", {
              defaultValue: "Your custom prompts will be used for all future AI processing.",
            }),
    });
  };

  const resetToDefault = () => {
    if (promptMode === PROMPT_MODES.UNIFIED) {
      setEditedUnifiedPrompt(UNIFIED_SYSTEM_PROMPT);
      localStorage.removeItem("customUnifiedPrompt");
    } else {
      setEditedAgentPrompt(LEGACY_PROMPTS.agent);
      setEditedRegularPrompt(LEGACY_PROMPTS.regular);
      localStorage.removeItem("customPrompts");
    }

    showAlertDialog({
      title: t("promptStudio.dialogs.reset.title"),
      description: t("promptStudio.dialogs.reset.description"),
    });
  };

  const copyText = (text: string, key: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 2000);
  };

  const testPrompt = async () => {
    if (!testText.trim()) return;

    setIsLoading(true);
    setTestResult("");

    try {
      const reasoningProvider = isCloudMode
        ? "openwhispr"
        : reasoningModel
          ? getModelProvider(reasoningModel)
          : "openai";

      logger.debug(
        "PromptStudio test starting",
        {
          useReasoningModel,
          isCloudMode,
          reasoningModel,
          reasoningProvider,
          testTextLength: testText.length,
          agentName,
          promptMode,
        },
        "prompt-studio"
      );

      if (!useReasoningModel) {
        setTestResult(t("promptStudio.test.disabledReasoning"));
        return;
      }

      if (!isCloudMode && !reasoningModel) {
        setTestResult(t("promptStudio.test.noModelSelected"));
        return;
      }

      if (!isCloudMode) {
        const providerConfig = PROVIDER_CONFIG[reasoningProvider] || {
          label: reasoningProvider.charAt(0).toUpperCase() + reasoningProvider.slice(1),
        };

        if (providerConfig.baseStorageKey) {
          const baseUrl = (useSettingsStore.getState().cloudReasoningBaseUrl || "").trim();
          if (!baseUrl) {
            setTestResult(
              t("promptStudio.test.baseUrlMissing", {
                provider:
                  reasoningProvider === "custom"
                    ? t("promptStudio.test.customEndpoint")
                    : providerConfig.label,
              })
            );
            return;
          }
        }
      }

      const modelToUse = isCloudMode ? effectiveModel || "auto" : reasoningModel;

      const previousMode = getPromptMode();
      const previousUnifiedPrompt = localStorage.getItem("customUnifiedPrompt");
      const previousLegacyPrompts = localStorage.getItem("customPrompts");

      setPromptMode(promptMode);
      if (promptMode === PROMPT_MODES.UNIFIED) {
        localStorage.setItem("customUnifiedPrompt", JSON.stringify(editedUnifiedPrompt));
      } else {
        localStorage.setItem(
          "customPrompts",
          JSON.stringify({
            agent: editedAgentPrompt,
            regular: editedRegularPrompt,
          })
        );
      }

      try {
        const result = await ReasoningService.processText(testText, modelToUse, agentName, {});
        setTestResult(result);
      } finally {
        setPromptMode(previousMode);

        if (previousUnifiedPrompt) {
          localStorage.setItem("customUnifiedPrompt", previousUnifiedPrompt);
        } else {
          localStorage.removeItem("customUnifiedPrompt");
        }

        if (previousLegacyPrompts) {
          localStorage.setItem("customPrompts", previousLegacyPrompts);
        } else {
          localStorage.removeItem("customPrompts");
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("PromptStudio test failed", { error: errorMessage }, "prompt-studio");
      setTestResult(t("promptStudio.test.failed", { error: errorMessage }));
    } finally {
      setIsLoading(false);
    }
  };

  const isAgentAddressed = testText.toLowerCase().includes(agentName.toLowerCase());
  const currentLegacyPrompts = getLegacyPrompts();
  const isCustomPrompt =
    promptMode === PROMPT_MODES.UNIFIED
      ? getCurrentUnifiedPrompt() !== UNIFIED_SYSTEM_PROMPT
      : hasCustomLegacyPrompts();

  const modeOptions = [
    {
      id: PROMPT_MODES.UNIFIED,
      label: t("promptStudio.modeSelector.unified", { defaultValue: "Unified" }),
      description: t("promptStudio.modeSelector.unifiedDescription", {
        defaultValue: "One smart prompt that handles cleanup and instructions.",
      }),
    },
    {
      id: PROMPT_MODES.AGENT_NORMAL,
      label: t("promptStudio.modeSelector.agentNormal", { defaultValue: "Agent + Normal" }),
      description: t("promptStudio.modeSelector.agentNormalDescription", {
        defaultValue: "Separate prompts for agent commands and normal cleanup.",
      }),
    },
  ] as const;

  const orderedModeOptions = [...modeOptions].sort((a, b) => {
    if (a.id === promptMode) return -1;
    if (b.id === promptMode) return 1;
    return 0;
  });

  const activeModeLabel =
    promptMode === PROMPT_MODES.UNIFIED
      ? t("promptStudio.modeSelector.unified", { defaultValue: "Unified" })
      : t("promptStudio.modeSelector.agentNormal", { defaultValue: "Agent + Normal" });

  const tabs = [
    { id: "current" as const, label: t("promptStudio.tabs.view"), icon: Eye },
    { id: "edit" as const, label: t("promptStudio.tabs.customize"), icon: Edit3 },
    { id: "test" as const, label: t("promptStudio.tabs.test"), icon: TestTube },
  ];

  return (
    <div className={className}>
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      <div className="rounded-xl border border-border/60 dark:border-border-subtle bg-card dark:bg-surface-2 overflow-hidden">
        <div className="flex border-b border-border/40 dark:border-border-subtle">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-xs font-medium transition-colors duration-150 border-b-2 ${
                  isActive
                    ? "border-primary text-foreground bg-primary/5 dark:bg-primary/3"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-black/2 dark:hover:bg-white/2"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="border-b border-border/40 dark:border-border-subtle px-4 py-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {orderedModeOptions.map((mode) => {
              const isActive = promptMode === mode.id;
              return (
                <button
                  key={mode.id}
                  onClick={() => {
                    setPromptModeState(mode.id);
                    setPromptMode(mode.id);
                  }}
                  className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                    isActive
                      ? "border-primary bg-primary/5 dark:bg-primary/10"
                      : "border-border/50 hover:border-border"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center justify-center rounded-full w-4 h-4 border ${
                        isActive
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-muted-foreground/40"
                      }`}
                    >
                      {isActive && <Check className="w-3 h-3" />}
                    </span>
                    <span className="text-xs font-semibold text-foreground">{mode.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{mode.description}</p>
                </button>
              );
            })}
          </div>
        </div>

        {activeTab === "current" && (
          <div className="divide-y divide-border/40 dark:divide-border-subtle">
            <div className="px-5 py-4">
              <div className="space-y-2">
                {[
                  {
                    mode: t("promptStudio.view.modes.cleanup.label"),
                    desc: t("promptStudio.view.modes.cleanup.description"),
                  },
                  {
                    mode: t("promptStudio.view.modes.agent.label"),
                    desc: t("promptStudio.view.modes.agent.description", { agentName }),
                  },
                ].map((item) => (
                  <div key={item.mode} className="flex items-start gap-3">
                    <span className="shrink-0 mt-0.5 text-xs font-medium uppercase tracking-wider px-1.5 py-px rounded bg-muted text-muted-foreground">
                      {item.mode}
                    </span>
                    <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-muted-foreground/60 uppercase tracking-wider">
                    {isCustomPrompt ? t("promptStudio.view.customPrompt") : t("promptStudio.view.defaultPrompt")}
                  </p>
                  <span className="text-xs font-semibold uppercase tracking-wider px-1.5 py-px rounded bg-muted text-muted-foreground">
                    {activeModeLabel}
                  </span>
                  {isCustomPrompt && (
                    <span className="text-xs font-semibold uppercase tracking-wider px-1.5 py-px rounded-full bg-primary/10 text-primary">
                      {t("promptStudio.view.modified")}
                    </span>
                  )}
                </div>
              </div>

              {promptMode === PROMPT_MODES.UNIFIED ? (
                <>
                  <div className="flex justify-end">
                    <Button
                      onClick={() => copyText(getCurrentUnifiedPrompt(), "unified")}
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                    >
                      {copiedKey === "unified" ? (
                        <>
                          <Check className="w-3 h-3 mr-1 text-success" /> {t("promptStudio.common.copied")}
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3 mr-1" /> {t("promptStudio.common.copy")}
                        </>
                      )}
                    </Button>
                  </div>
                  <div className="bg-muted/30 dark:bg-surface-raised/30 border border-border/30 rounded-lg p-4 max-h-80 overflow-y-auto">
                    <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
                      {getCurrentUnifiedPrompt().replace(/\{\{agentName\}\}/g, agentName)}
                    </pre>
                  </div>
                </>
              ) : (
                <div className="grid gap-3">
                  {[
                    {
                      key: "agent",
                      title: t("promptStudio.view.agentPrompt", { defaultValue: "Agent Prompt" }),
                      value: currentLegacyPrompts.agent,
                    },
                    {
                      key: "normal",
                      title: t("promptStudio.view.normalPrompt", { defaultValue: "Normal Prompt" }),
                      value: currentLegacyPrompts.regular,
                    },
                  ].map((item) => (
                    <div key={item.key} className="border border-border/30 rounded-lg overflow-hidden">
                      <div className="px-3 py-2 bg-muted/20 border-b border-border/30 flex items-center justify-between">
                        <p className="text-xs font-medium text-foreground">{item.title}</p>
                        <Button
                          onClick={() => copyText(item.value, item.key)}
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5"
                        >
                          {copiedKey === item.key ? (
                            <Check className="w-3 h-3 text-success" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </Button>
                      </div>
                      <div className="p-3 max-h-52 overflow-y-auto bg-muted/30 dark:bg-surface-raised/30">
                        <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
                          {item.value.replace(/\{\{agentName\}\}/g, agentName)}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "edit" && (
          <div className="divide-y divide-border/40 dark:divide-border-subtle">
            <div className="px-5 py-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                <span className="font-medium text-warning">{t("promptStudio.edit.cautionLabel")}</span>{" "}
                {t("promptStudio.edit.cautionTextPrefix")}{" "}
                <code className="text-xs bg-muted/50 px-1 py-0.5 rounded font-mono">{"{{agentName}}"}</code>{" "}
                {t("promptStudio.edit.cautionTextSuffix")}
              </p>
            </div>

            <div className="px-5 py-4 space-y-4">
              {promptMode === PROMPT_MODES.UNIFIED ? (
                <Textarea
                  value={editedUnifiedPrompt}
                  onChange={(e) => setEditedUnifiedPrompt(e.target.value)}
                  rows={16}
                  className="font-mono text-xs leading-relaxed"
                  placeholder={t("promptStudio.edit.placeholder")}
                />
              ) : (
                <>
                  <div>
                    <p className="text-xs font-medium text-foreground mb-2">
                      {t("promptStudio.edit.agentPromptLabel", { defaultValue: "Agent Prompt" })}
                    </p>
                    <Textarea
                      value={editedAgentPrompt}
                      onChange={(e) => setEditedAgentPrompt(e.target.value)}
                      rows={8}
                      className="font-mono text-xs leading-relaxed"
                      placeholder={t("promptStudio.edit.agentPromptPlaceholder", {
                        defaultValue: "Enter your agent prompt...",
                      })}
                    />
                  </div>
                  <div>
                    <p className="text-xs font-medium text-foreground mb-2">
                      {t("promptStudio.edit.normalPromptLabel", { defaultValue: "Normal Prompt" })}
                    </p>
                    <Textarea
                      value={editedRegularPrompt}
                      onChange={(e) => setEditedRegularPrompt(e.target.value)}
                      rows={8}
                      className="font-mono text-xs leading-relaxed"
                      placeholder={t("promptStudio.edit.normalPromptPlaceholder", {
                        defaultValue: "Enter your normal prompt...",
                      })}
                    />
                  </div>
                </>
              )}
              <p className="text-xs text-muted-foreground/50">
                {t("promptStudio.edit.agentNameLabel")}{" "}
                <span className="font-medium text-foreground">{agentName}</span>
              </p>
            </div>

            <div className="px-5 py-4">
              <div className="flex gap-2">
                <Button onClick={savePrompt} size="sm" className="flex-1">
                  <Save className="w-3.5 h-3.5 mr-2" />
                  {t("promptStudio.common.save")}
                </Button>
                <Button onClick={resetToDefault} variant="outline" size="sm">
                  <RotateCcw className="w-3.5 h-3.5 mr-2" />
                  {t("promptStudio.common.reset")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "test" &&
          (() => {
            const reasoningProvider = isCloudMode
              ? "openwhispr"
              : reasoningModel
                ? getModelProvider(reasoningModel)
                : "openai";
            const providerConfig = PROVIDER_CONFIG[reasoningProvider] || {
              label: reasoningProvider.charAt(0).toUpperCase() + reasoningProvider.slice(1),
            };

            const displayModel = isCloudMode
              ? t("promptStudio.test.openwhisprCloud")
              : reasoningModel || t("promptStudio.test.none");
            const displayProvider =
              reasoningProvider === "custom"
                ? t("promptStudio.test.customEndpoint")
                : providerConfig.label;

            return (
              <div className="divide-y divide-border/40 dark:divide-border-subtle">
                {!useReasoningModel && (
                  <div className="px-5 py-4">
                    <div className="rounded-lg border border-warning/20 bg-warning/5 dark:bg-warning/10 px-4 py-3">
                      <div className="flex items-start gap-2.5">
                        <AlertTriangle className="w-3.5 h-3.5 text-warning mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {t("promptStudio.test.disabledInSettingsPrefix")}{" "}
                          <span className="font-medium text-foreground">
                            {t("promptStudio.test.aiModels")}
                          </span>{" "}
                          {t("promptStudio.test.disabledInSettingsSuffix")}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <div className="px-5 py-4">
                  <div className="flex items-center gap-4 flex-wrap">
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground/60 uppercase tracking-wider">
                        {t("promptStudio.test.modelLabel")}
                      </p>
                      <p className="text-xs font-medium text-foreground font-mono">{displayModel}</p>
                    </div>
                    <div className="h-3 w-px bg-border/40" />
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground/60 uppercase tracking-wider">
                        {t("promptStudio.test.providerLabel")}
                      </p>
                      <p className="text-xs font-medium text-foreground">{displayProvider}</p>
                    </div>
                    <div className="h-3 w-px bg-border/40" />
                    <div className="flex items-center gap-2">
                      <p className="text-xs text-muted-foreground/60 uppercase tracking-wider">
                        {t("promptStudio.test.modeLabel", { defaultValue: "Mode" })}
                      </p>
                      <p className="text-xs font-medium text-foreground">{activeModeLabel}</p>
                    </div>
                  </div>
                </div>

                <div className="px-5 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium text-foreground">{t("promptStudio.test.inputLabel")}</p>
                    {testText && (
                      <span
                        className={`text-xs font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                          isAgentAddressed
                            ? "bg-primary/10 text-primary dark:bg-primary/15"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {isAgentAddressed
                          ? t("promptStudio.test.instruction")
                          : t("promptStudio.test.cleanup")}
                      </span>
                    )}
                  </div>
                  <Textarea
                    value={testText}
                    onChange={(e) => setTestText(e.target.value)}
                    rows={3}
                    className="text-xs"
                    placeholder={t("promptStudio.test.inputPlaceholder")}
                  />
                  <p className="text-xs text-muted-foreground/40 mt-1.5">
                    {t("promptStudio.test.addressHint", { agentName })}
                  </p>
                </div>

                <div className="px-5 py-4">
                  <Button
                    onClick={testPrompt}
                    disabled={!testText.trim() || isLoading || !useReasoningModel}
                    size="sm"
                    className="w-full"
                  >
                    <Play className="w-3.5 h-3.5 mr-2" />
                    {isLoading ? t("promptStudio.test.processing") : t("promptStudio.test.run")}
                  </Button>
                </div>

                {testResult && (
                  <div className="px-5 py-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-xs font-medium text-foreground">{t("promptStudio.test.outputLabel")}</p>
                      <Button
                        onClick={() => copyText(testResult, "result")}
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1.5"
                      >
                        {copiedKey === "result" ? (
                          <Check className="w-3 h-3 text-success" />
                        ) : (
                          <Copy className="w-3 h-3 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
                    <div className="bg-muted/30 dark:bg-surface-raised/30 border border-border/30 rounded-lg p-4 max-h-48 overflow-y-auto">
                      <pre className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">
                        {testResult}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
      </div>
    </div>
  );
}
