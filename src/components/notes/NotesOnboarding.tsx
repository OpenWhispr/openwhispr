import { useState, useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { Sparkles, Plus, ChevronRight, Zap, Loader2, Check, Monitor } from "../icons";
import { Button } from "../ui/button";
import { cn } from "../lib/utils";
import {
  selectPolicyEffectiveSettings,
  selectResolvedLLMConfig,
  useSettingsStore,
} from "../../stores/settingsStore";
import { useNotesOnboarding } from "../../hooks/useNotesOnboarding";
import { NOTE_ACTION_LIMITS } from "../../helpers/builtinActions";
import { useToast } from "../ui/useToast";
import {
  useActionsOfKind,
  initializeActions,
  getActionName,
  getActionDescription,
  resolveTemplate,
} from "../../stores/actionStore";
import { notesInputClass, notesTextareaClass } from "./shared";
import { useDialogs } from "../../hooks/useDialogs";
import { AlertDialog } from "../ui/dialog";
import ReasoningModelSelector from "../ReasoningModelSelector";
import { useSystemAudioPermission } from "../../hooks/useSystemAudioPermission";
import { canManageSystemAudioInApp } from "../../utils/systemAudioAccess";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { PAGE_CONTENT_WIDTH_CLASS } from "../ui/pageWidth";
import { PAGE_HERO_ICON_TILE_CLASS } from "../ui/surfaces";

const CARD_CLASS = "rounded-2xl border transition-colors duration-200";
const CARD_IDLE_CLASS = "border-border/70 bg-card/50 dark:border-white/10 dark:bg-surface-2/60";
const CARD_DONE_CLASS = "border-success/20 bg-success/[0.03]";

interface NotesOnboardingProps {
  onComplete: () => void;
}

export default function NotesOnboarding({ onComplete }: NotesOnboardingProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { isProUser, isProLoading, isLLMConfigured, complete } = useNotesOnboarding();
  const templates = useActionsOfKind("template");
  const [llmExpanded, setLlmExpanded] = useState(!isLLMConfigured && !isProUser);
  const [createExpanded, setCreateExpanded] = useState(false);
  const [actionName, setActionName] = useState("");
  const [actionDescription, setActionDescription] = useState("");
  const [actionPrompt, setActionPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [justCreated, setJustCreated] = useState(false);

  const policyState = usePolicySnapshot();
  const cleanupConfig = useSettingsStore(
    useShallow((settings) =>
      selectResolvedLLMConfig(
        selectPolicyEffectiveSettings(settings, policyState),
        "dictationCleanup"
      )
    )
  );
  const setCleanupModel = useSettingsStore((s) => s.setCleanupModel);
  const setCleanupProvider = useSettingsStore((s) => s.setCleanupProvider);
  const setCleanupMode = useSettingsStore((s) => s.setCleanupMode);
  const setCleanupCloudBaseUrl = useSettingsStore((s) => s.setCleanupCloudBaseUrl);
  const setCleanupCustomApiKey = useSettingsStore((s) => s.setCleanupCustomApiKey);

  const { alertDialog, hideAlertDialog } = useDialogs();
  const {
    granted: systemAudioGranted,
    mode: systemAudioMode,
    request: requestSystemAudio,
  } = useSystemAudioPermission();
  const [isRequestingSystemAudio, setIsRequestingSystemAudio] = useState(false);
  const shouldShowSystemAudioPermission = canManageSystemAudioInApp({
    mode: systemAudioMode,
  });

  const handleGrantSystemAudio = useCallback(async () => {
    setIsRequestingSystemAudio(true);
    try {
      await requestSystemAudio();
    } finally {
      setIsRequestingSystemAudio(false);
    }
  }, [requestSystemAudio]);

  useEffect(() => {
    initializeActions();
  }, []);

  const handleCreateAction = async () => {
    if (!actionName.trim() || !actionPrompt.trim()) return;
    setIsSaving(true);
    try {
      const result = await window.electronAPI.createAction(
        actionName.trim(),
        actionDescription.trim(),
        actionPrompt.trim()
      );
      if (!result.success) {
        toast({ title: t("notes.actions.errors.saveFailed"), variant: "destructive" });
        return;
      }
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

  // The template the summary button writes with, and the ones the user made.
  const builtInAction = resolveTemplate(templates, null);
  const customActions = templates.filter((a) => a.is_builtin !== 1);

  return (
    <div className="h-full overflow-y-auto">
      <div
        className={cn(PAGE_CONTENT_WIDTH_CLASS, "flex flex-col gap-5 px-6 py-8")}
        style={{ animation: "float-up 0.4s ease-out" }}
      >
        <div className="flex flex-col items-center gap-2 pt-4 text-center">
          <div className={cn(PAGE_HERO_ICON_TILE_CLASS, "mb-1")}>
            <Sparkles size={20} className="text-foreground/60" />
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {t("notes.onboarding.templates.title")}
          </h2>
          <p className="max-w-xl text-[13px] leading-relaxed text-foreground/50 dark:text-foreground/45">
            {t("notes.onboarding.templates.description")}
          </p>
        </div>

        {/* LLM Configuration — non-Pro only, deferred until pro status is known */}
        {!isProLoading && !isProUser && (
          <div className={cn(CARD_CLASS, isLLMConfigured ? CARD_DONE_CLASS : CARD_IDLE_CLASS)}>
            <button
              type="button"
              onClick={() => setLlmExpanded(!llmExpanded)}
              aria-expanded={llmExpanded}
              className="flex w-full items-center justify-between px-5 py-4 text-start"
            >
              <div className="flex items-center gap-3">
                <Zap
                  size={16}
                  className={cn(isLLMConfigured ? "text-success/70" : "text-foreground/45")}
                />
                <span className="text-sm font-medium text-foreground">
                  {t("notes.onboarding.llm.title")}
                </span>
                {isLLMConfigured && (
                  <span className="text-xs font-medium text-success/70">
                    {t("notes.onboarding.llm.configured")}
                  </span>
                )}
              </div>
              <ChevronRight
                size={14}
                className={cn(
                  "text-foreground/45 transition-transform duration-200",
                  llmExpanded ? "rotate-90" : "rtl:rotate-180"
                )}
              />
            </button>

            {llmExpanded && (
              <div className="space-y-4 px-5 pb-5" style={{ animation: "float-up 0.2s ease-out" }}>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t("notes.onboarding.llm.description")}
                </p>

                <ReasoningModelSelector
                  reasoningModel={cleanupConfig.model}
                  setReasoningModel={setCleanupModel}
                  localReasoningProvider={cleanupConfig.provider}
                  setLocalReasoningProvider={setCleanupProvider}
                  cloudReasoningBaseUrl={cleanupConfig.cloudBaseUrl ?? ""}
                  setCloudReasoningBaseUrl={setCleanupCloudBaseUrl}
                  customReasoningApiKey={cleanupConfig.customApiKey ?? ""}
                  setCustomReasoningApiKey={setCleanupCustomApiKey}
                  setReasoningMode={setCleanupMode}
                />
              </div>
            )}
          </div>
        )}

        {/* System Audio Permission */}
        {shouldShowSystemAudioPermission && (
          <div className={cn(CARD_CLASS, systemAudioGranted ? CARD_DONE_CLASS : CARD_IDLE_CLASS)}>
            <div className="flex w-full items-center justify-between gap-4 px-5 py-4">
              <div className="flex items-center gap-3">
                <Monitor
                  size={16}
                  className={cn(
                    "shrink-0",
                    systemAudioGranted ? "text-success/70" : "text-foreground/45"
                  )}
                />
                <div>
                  <span className="text-sm font-medium text-foreground">
                    {t("notes.onboarding.systemAudio.title")}
                  </span>
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    {t("notes.onboarding.systemAudio.description")}
                  </p>
                </div>
              </div>
              {systemAudioGranted ? (
                <span className="shrink-0 text-xs font-medium text-success/70">
                  {t("notes.onboarding.systemAudio.enabled")}
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleGrantSystemAudio}
                  disabled={isRequestingSystemAudio}
                  className="shrink-0"
                >
                  {isRequestingSystemAudio ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    t("notes.onboarding.systemAudio.grant")
                  )}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Built-in action, plus any custom actions the user just created */}
        <div>
          <p className="pb-2.5 text-sm text-muted-foreground">
            {t("notes.onboarding.templates.builtInLabel")}
          </p>
          {(builtInAction || customActions.length > 0) && (
            <div
              className={cn(
                CARD_CLASS,
                CARD_IDLE_CLASS,
                "divide-y divide-border/60 overflow-clip dark:divide-white/10"
              )}
            >
              {builtInAction && (
                <div className="flex items-center gap-3 px-5 py-3.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-accent/10 bg-accent/8 dark:border-accent/15 dark:bg-accent/12">
                    <Sparkles size={14} className="text-accent/60" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">
                      {getActionName(builtInAction, t)}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      {getActionDescription(builtInAction, t)}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-medium text-muted-foreground">
                    {t("notes.actions.builtIn")}
                  </span>
                </div>
              )}
              {customActions.map((action) => (
                <div key={action.id} className="flex items-center gap-3 px-5 py-3.5">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-success/15 bg-success/8 dark:border-success/20">
                    <Check size={14} className="text-success/70" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{action.name}</p>
                    {action.description && (
                      <p className="truncate text-sm text-muted-foreground">{action.description}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Create custom action */}
        <div className={cn(CARD_CLASS, CARD_IDLE_CLASS)}>
          <button
            type="button"
            onClick={() => setCreateExpanded(!createExpanded)}
            aria-expanded={createExpanded}
            className="flex w-full items-center justify-between px-5 py-4 text-start"
          >
            <div className="flex items-center gap-3">
              <Plus size={16} className="text-foreground/45" />
              <span className="text-sm font-medium text-foreground">
                {t("notes.onboarding.templates.createTitle")}
              </span>
              {justCreated && (
                <span className="text-xs font-medium text-success/70">
                  {t("notes.onboarding.templates.created")}
                </span>
              )}
            </div>
            <ChevronRight
              size={14}
              className={cn(
                "text-foreground/45 transition-transform duration-200",
                createExpanded ? "rotate-90" : "rtl:rotate-180"
              )}
            />
          </button>

          {createExpanded && (
            <div className="space-y-2.5 px-5 pb-5" style={{ animation: "float-up 0.2s ease-out" }}>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t("notes.onboarding.templates.createDescription")}
              </p>
              <input
                dir="auto"
                type="text"
                value={actionName}
                onChange={(e) => setActionName(e.target.value)}
                maxLength={NOTE_ACTION_LIMITS.name}
                placeholder={t("notes.templates.namePlaceholder")}
                aria-label={t("notes.templates.namePlaceholder")}
                disabled={isSaving}
                className={cn(notesInputClass, "h-9 text-sm disabled:opacity-40")}
              />
              <input
                dir="auto"
                type="text"
                value={actionDescription}
                onChange={(e) => setActionDescription(e.target.value)}
                maxLength={NOTE_ACTION_LIMITS.description}
                placeholder={t("notes.actions.descriptionPlaceholder")}
                aria-label={t("notes.actions.descriptionPlaceholder")}
                disabled={isSaving}
                className={cn(notesInputClass, "h-9 text-sm disabled:opacity-40")}
              />
              <textarea
                dir="auto"
                value={actionPrompt}
                onChange={(e) => setActionPrompt(e.target.value)}
                maxLength={NOTE_ACTION_LIMITS.prompt}
                placeholder={t("notes.templates.contextPlaceholder")}
                aria-label={t("notes.templates.contextPlaceholder")}
                rows={3}
                disabled={isSaving}
                className={cn(notesTextareaClass, "text-sm disabled:opacity-40")}
              />
              <div className="flex justify-end">
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleCreateAction}
                  disabled={isSaving || !actionName.trim() || !actionPrompt.trim()}
                >
                  {isSaving ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    t("notes.actions.save")
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-center pt-2 pb-4">
          <Button onClick={handleComplete} className="rounded-full px-6 font-medium">
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
