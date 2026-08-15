import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Mail, Mic, Sparkles } from "lucide-react";
import AuthenticationStep from "./AuthenticationStep";
import EmailVerificationStep from "./EmailVerificationStep";
import PermissionsSection from "./ui/PermissionsSection";
import UseCaseStep from "./onboarding/UseCaseStep";
import OnboardingShell, { BrandMark, OnboardingStepHeader } from "./onboarding/OnboardingShell";
import LanguageSelectionStep from "./onboarding/LanguageSelectionStep";
import ShortcutSetupStep from "./onboarding/ShortcutSetupStep";
import DemoStep from "./onboarding/DemoStep";
import CalendarConnectionsStep from "./onboarding/CalendarConnectionsStep";
import SetupChoiceStep from "./onboarding/SetupChoiceStep";
import {
  ByokProviderStep,
  EnterpriseSetupStep,
  LocalModelSetupStep,
} from "./onboarding/ProviderSetupStep";
import { AlertDialog } from "./ui/dialog";
import { useAuth } from "../hooks/useAuth";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { useSettings } from "../hooks/useSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { usePolicyStore } from "../stores/policyStore";
import { isAgentAllowed } from "../stores/policyRules";
import { useSettingsStore } from "../stores/settingsStore";
import {
  formatHotkeyLabel,
  getDefaultHotkey,
  parseHotkeyList,
  serializeHotkeyList,
} from "../utils/hotkeys";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { validateHotkeyForSlot } from "../utils/hotkeyValidation";
import { getPlatform } from "../utils/platform";
import { ACCESSIBILITY_SKIPPED_KEY, areRequiredPermissionsMet } from "../utils/permissions";
import { cloudPost } from "../services/cloudApi";
import logger from "../utils/logger";
import {
  getNextOnboardingStep,
  getOnboardingRoute,
  reconcileStepWithRoute,
  type OnboardingSetupMode,
  type OnboardingStepId,
} from "./onboarding/flow";
import { useOnboardingSession } from "./onboarding/useOnboardingSession";

interface OnboardingFlowProps {
  onComplete: (options?: { openSettings?: boolean }) => void;
}

const COMPACT_STEPS = new Set<OnboardingStepId>(["auth", "permissions"]);

function progressForStep(stepId: OnboardingStepId): number {
  if (["languages", "assistant-demo", "setup-choice"].includes(stepId)) return 0;
  if (["use-cases", "dictation-demo"].includes(stepId)) return 1;
  if (["dictation-hotkey", "assistant-hotkey"].includes(stepId)) return 2;
  if (stepId === "notes") return 3;
  return stepId.endsWith("assistant") ? 1 : 0;
}

function AssistantPreview({ hotkey }: { hotkey: string }) {
  const { t } = useTranslation();

  return (
    <div className="onboarding-code-hero mx-auto mb-7 max-w-4xl overflow-hidden rounded-3xl border border-border p-5 shadow-lg md:p-7">
      <div className="mx-auto grid max-w-3xl gap-4 md:grid-cols-[1fr_0.9fr]">
        <div className="rounded-2xl border border-border/70 bg-card/90 p-4 shadow-sm backdrop-blur">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Mail className="size-4" />
            </span>
            <div className="min-w-0 space-y-2">
              <p className="text-xs font-semibold text-foreground">Eren</p>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("onboarding.rehaul.assistantDemo.email")}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-primary/20 bg-card/90 p-4 shadow-sm backdrop-blur">
          <div className="flex items-center gap-2 text-xs font-semibold text-primary">
            <Sparkles className="size-4" />
            OpenWhispr Assistant
          </div>
          <p className="mt-3 text-xs leading-5 text-foreground">
            {t("onboarding.rehaul.assistantDemo.prompt")}
          </p>
          <div className="mt-4 flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-2 text-xs text-muted-foreground">
            <Mic className="size-3.5 text-primary" />
            <span className="truncate">{formatHotkeyLabel(hotkey)}</span>
            <span className="ml-auto flex items-end gap-0.5" aria-hidden="true">
              {[2, 4, 6, 4, 3].map((height, index) => (
                <span key={index} className="w-0.5 rounded-full bg-primary" style={{ height }} />
              ))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation();
  const { isSignedIn } = useAuth();
  const agentAllowed = usePolicyStore(isAgentAllowed);
  const settings = useSettings();
  const settingsStore = useSettingsStore();
  const { session, setSession, goTo, goBack, setAuthPath, setSetupMode, clearSession } =
    useOnboardingSession();

  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [dictationHotkey, setDictationHotkey] = useState(
    () => parseHotkeyList(settings.dictationKey)[0] || getDefaultHotkey()
  );
  const [assistantHotkey, setAssistantHotkey] = useState(
    () => parseHotkeyList(settings.voiceAgentKey)[0] || "CommandOrControl+Shift+Space"
  );
  const [dictationHotkeyConfirmed, setDictationHotkeyConfirmed] = useState(false);
  const [assistantHotkeyConfirmed, setAssistantHotkeyConfirmed] = useState(false);
  const [dictationDemoSuccess, setDictationDemoSuccess] = useState(false);
  const [assistantDemoSuccess, setAssistantDemoSuccess] = useState(false);
  const [stageReady, setStageReady] = useState(false);
  const [isFinishing, setIsFinishing] = useState(false);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [permissionAlert, setPermissionAlert] = useState<{
    title: string;
    description: string;
  } | null>(null);
  const [, setAccessibilitySkipped] = useLocalStorage(ACCESSIBILITY_SKIPPED_KEY, false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const permissions = usePermissions((dialog) =>
    setPermissionAlert({ title: dialog.title, description: dialog.description })
  );
  useClipboard((dialog) =>
    setPermissionAlert({ title: dialog.title, description: dialog.description })
  );
  const systemAudio = useSystemAudioPermission();

  const route = useMemo(
    () =>
      getOnboardingRoute({
        authPath: session.authPath,
        setupMode: session.setupMode,
        agentAllowed,
      }),
    [agentAllowed, session.authPath, session.setupMode]
  );
  const currentStepId = reconcileStepWithRoute(session.currentStepId, route);
  const compact = COMPACT_STEPS.has(currentStepId);

  useEffect(() => {
    if (session.currentStepId !== currentStepId) {
      setSession((current) => ({ ...current, currentStepId }));
    }
  }, [currentStepId, session.currentStepId, setSession]);

  useEffect(() => {
    void window.electronAPI?.setOnboardingWindowMode?.(compact ? "compact" : "expanded");
  }, [compact]);

  useEffect(() => {
    setStageReady(false);
  }, [currentStepId]);

  const withExtraDictationHotkeys = useCallback(
    (primary: string) =>
      serializeHotkeyList([primary, ...parseHotkeyList(settings.dictationKey).slice(1)]),
    [settings.dictationKey]
  );

  const { registerHotkey, isRegistering } = useHotkeyRegistration({
    onSuccess: (registered) => {
      const primary = parseHotkeyList(registered)[0] || registered;
      setDictationHotkey(primary);
      settings.setDictationKey(registered);
    },
    showSuccessToast: false,
    showErrorToast: false,
  });

  const validateDictationHotkey = useCallback(
    (value: string) => getValidationMessage(value, getPlatform()),
    []
  );
  const validateAssistantHotkey = useCallback(
    (value: string) =>
      validateHotkeyForSlot(
        value,
        { "settingsPage.general.hotkey.title": withExtraDictationHotkeys(dictationHotkey) },
        t
      ),
    [dictationHotkey, t, withExtraDictationHotkeys]
  );

  const syncUseCases = useCallback(() => {
    if (!isSignedIn || session.authPath === "guest") return;
    cloudPost("/api/onboarding-intent", {
      useCases: settings.onboardingUseCases,
      note: settings.onboardingUseCaseNote || undefined,
    }).catch((error) => logger.warn("Failed to sync onboarding intent", { error }, "onboarding"));
  }, [isSignedIn, session.authPath, settings.onboardingUseCaseNote, settings.onboardingUseCases]);

  const finalizeOnboarding = useCallback(
    async (mode: Exclude<OnboardingSetupMode, null>, options: { localPending?: boolean } = {}) => {
      if (isFinishing) return;
      setIsFinishing(true);
      setFatalError(null);
      try {
        const registered = await registerHotkey(withExtraDictationHotkeys(dictationHotkey));
        if (!registered) {
          setFatalError(t("onboarding.hotkey.couldNotRegisterDescription"));
          return;
        }

        if (mode === "cloud") {
          const health = await window.electronAPI?.cloudHealthCheck?.();
          if (health && !health.ok && health.status === undefined) {
            setFatalError(t(health.messageKey || "streaming.errors.cloudUnreachable.generic"));
            return;
          }
        }

        const skippedAuth = session.authPath === "guest";
        localStorage.setItem("authenticationSkipped", String(skippedAuth));
        localStorage.setItem("skipAuth", String(skippedAuth));
        localStorage.setItem("onboardingCompleted", "true");
        if (options.localPending) localStorage.setItem("localSetupPending", "true");
        else localStorage.removeItem("localSetupPending");
        await window.electronAPI?.saveAllKeysToEnv?.();
        await window.electronAPI?.markBundleMigrated?.();
        clearSession();
        await window.electronAPI?.setOnboardingWindowMode?.("restore");
        onComplete();
      } catch (error) {
        logger.error("Failed to finish onboarding", { error }, "onboarding");
        setFatalError(t("common.unknownError"));
      } finally {
        setIsFinishing(false);
      }
    },
    [
      clearSession,
      dictationHotkey,
      isFinishing,
      onComplete,
      registerHotkey,
      session.authPath,
      t,
      withExtraDictationHotkeys,
    ]
  );

  const applyReasoningSelectionToAllScopes = useCallback(() => {
    settingsStore.setCloudReasoningForAllScopes({
      cleanupCloudMode: "byok",
      cleanupProvider: settingsStore.chatAgentProvider,
      cleanupModel: settingsStore.chatAgentModel,
      useCleanupModel: true,
      useDictationAgent: true,
    });
  }, [settingsStore]);

  const handleSetupSelection = useCallback(
    async (mode: Exclude<OnboardingSetupMode, null>) => {
      setSetupMode(mode);
      if (mode === "cloud") {
        settingsStore.setCloudTranscriptionForAllScopes({
          useLocalWhisper: false,
          cloudTranscriptionMode: "openwhispr",
          cloudTranscriptionProvider: "openwhispr",
        });
        settingsStore.setCloudReasoningForAllScopes({
          cleanupCloudMode: "openwhispr",
          cleanupProvider: "openwhispr",
        });
        await finalizeOnboarding("cloud");
        return;
      }
      const nextRoute = getOnboardingRoute({
        authPath: session.authPath,
        setupMode: mode,
        agentAllowed,
      });
      const choiceIndex = nextRoute.indexOf("setup-choice");
      const next = nextRoute[choiceIndex + 1];
      if (next) goTo(next);
    },
    [agentAllowed, finalizeOnboarding, goTo, session.authPath, setSetupMode, settingsStore]
  );

  const continueFromCurrentStep = useCallback(async () => {
    if (currentStepId === "permissions") {
      if (getPlatform() === "darwin" && !permissions.accessibilityPermissionGranted) {
        setAccessibilitySkipped(true);
      }
    } else if (currentStepId === "languages") {
      settings.setPreferredLanguage(
        settings.spokenLanguages.length === 1 ? settings.spokenLanguages[0] : "auto"
      );
    } else if (currentStepId === "use-cases") {
      syncUseCases();
    } else if (currentStepId === "dictation-hotkey") {
      const registered = await registerHotkey(withExtraDictationHotkeys(dictationHotkey));
      if (!registered) {
        setFatalError(t("onboarding.hotkey.couldNotRegisterDescription"));
        return;
      }
    } else if (currentStepId === "assistant-hotkey") {
      settings.setVoiceAgentKey(
        serializeHotkeyList([assistantHotkey, ...parseHotkeyList(settings.voiceAgentKey).slice(1)])
      );
    } else if (currentStepId === "byok-dictation") {
      settingsStore.setCloudTranscriptionForAllScopes({
        useLocalWhisper: false,
        cloudTranscriptionMode: "byok",
      });
    } else if (currentStepId === "byok-assistant") {
      applyReasoningSelectionToAllScopes();
    } else if (currentStepId === "local-dictation") {
      settingsStore.setCloudTranscriptionForAllScopes({ useLocalWhisper: true });
    } else if (currentStepId === "local-assistant") {
      applyReasoningSelectionToAllScopes();
    } else if (currentStepId === "enterprise-dictation") {
      settingsStore.setDictationAgentMode("enterprise");
    } else if (currentStepId === "enterprise-assistant") {
      applyReasoningSelectionToAllScopes();
    }

    const next = getNextOnboardingStep(currentStepId, route);
    if (next) {
      goTo(next);
      if (next === "dictation-demo") window.electronAPI?.showDictationPanel?.();
      return;
    }

    if (session.setupMode) await finalizeOnboarding(session.setupMode);
  }, [
    applyReasoningSelectionToAllScopes,
    assistantHotkey,
    currentStepId,
    dictationHotkey,
    finalizeOnboarding,
    goTo,
    permissions.accessibilityPermissionGranted,
    registerHotkey,
    route,
    session.setupMode,
    setAccessibilitySkipped,
    settings,
    settingsStore,
    syncUseCases,
    t,
    withExtraDictationHotkeys,
  ]);

  const skipLocalSetup = useCallback(async () => {
    const next = getNextOnboardingStep(currentStepId, route);
    if (next) {
      localStorage.setItem("localSetupPending", "true");
      goTo(next);
      return;
    }
    await finalizeOnboarding("local", { localPending: true });
  }, [currentStepId, finalizeOnboarding, goTo, route]);

  const canContinue = (() => {
    switch (currentStepId) {
      case "permissions":
        return areRequiredPermissionsMet(permissions.micPermissionGranted);
      case "languages":
        return settings.spokenLanguages.length > 0;
      case "dictation-hotkey":
        return dictationHotkeyConfirmed;
      case "dictation-demo":
        return dictationDemoSuccess;
      case "assistant-hotkey":
        return assistantHotkeyConfirmed;
      case "assistant-demo":
        return assistantDemoSuccess;
      case "byok-dictation":
      case "byok-assistant":
      case "local-dictation":
      case "local-assistant":
      case "enterprise-dictation":
      case "enterprise-assistant":
        return stageReady;
      default:
        return true;
    }
  })();

  const onDictationDemoSuccess = useCallback(setDictationDemoSuccess, [setDictationDemoSuccess]);
  const onAssistantDemoSuccess = useCallback(setAssistantDemoSuccess, [setAssistantDemoSuccess]);
  const onStageReady = useCallback(setStageReady, [setStageReady]);

  const renderStep = () => {
    switch (currentStepId) {
      case "auth":
        return (
          <div className="min-h-full w-full">
            {pendingVerificationEmail ? (
              <EmailVerificationStep
                email={pendingVerificationEmail}
                onVerified={() => {
                  setPendingVerificationEmail(null);
                  setAuthPath("account");
                  goTo(session.setupMode === "cloud" ? "setup-choice" : "permissions");
                }}
                onBack={() => setPendingVerificationEmail(null)}
              />
            ) : (
              <AuthenticationStep
                onContinueWithoutAccount={() => {
                  setAuthPath("guest");
                  goTo("setup-choice");
                }}
                onAuthComplete={() => {
                  setAuthPath("account");
                  goTo(session.setupMode === "cloud" ? "setup-choice" : "permissions");
                }}
                onNeedsVerification={setPendingVerificationEmail}
              />
            )}
          </div>
        );

      case "permissions":
        return (
          <div className="w-full max-w-lg rounded-3xl border border-border bg-card p-6 shadow-xl">
            <div className="text-center">
              <BrandMark className="mx-auto size-14 text-primary" />
              <h1 className="mt-4 text-2xl font-medium text-foreground">
                {t("onboarding.rehaul.permissions.title")}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">{t("auth.welcomeSubtitle")}</p>
            </div>
            <div className="mt-6 rounded-2xl bg-muted/50 p-2">
              <PermissionsSection permissions={permissions} systemAudio={systemAudio} />
            </div>
          </div>
        );

      case "languages":
        return (
          <div className="w-full">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.languages.title")}
              description={t("onboarding.rehaul.languages.description")}
            />
            <LanguageSelectionStep
              selected={settings.spokenLanguages}
              onChange={settings.setSpokenLanguages}
              searchPlaceholder={t("languageSelector.searchPlaceholder")}
              noResultsLabel={t("languageSelector.noLanguagesFound")}
              selectedLabel={t("onboarding.rehaul.languages.title")}
            />
          </div>
        );

      case "use-cases":
        return (
          <div className="w-full max-w-3xl rounded-3xl border border-border bg-card p-6 shadow-lg md:p-8">
            <UseCaseStep
              useCases={settings.onboardingUseCases}
              onUseCasesChange={settings.setOnboardingUseCases}
              note={settings.onboardingUseCaseNote}
              onNoteChange={settings.setOnboardingUseCaseNote}
            />
          </div>
        );

      case "dictation-hotkey":
      case "assistant-hotkey": {
        const assistant = currentStepId === "assistant-hotkey";
        return (
          <div className="w-full">
            {assistant && <AssistantPreview hotkey={assistantHotkey} />}
            <OnboardingStepHeader
              title={t(
                assistant
                  ? "onboarding.rehaul.assistantHotkey.title"
                  : "onboarding.rehaul.dictationHotkey.title"
              )}
              description={t(
                assistant
                  ? "onboarding.rehaul.assistantHotkey.description"
                  : "onboarding.rehaul.dictationHotkey.description"
              )}
            />
            <ShortcutSetupStep
              value={
                (assistant ? assistantHotkeyConfirmed : dictationHotkeyConfirmed)
                  ? assistant
                    ? assistantHotkey
                    : dictationHotkey
                  : ""
              }
              onChange={(value) => {
                if (assistant) {
                  setAssistantHotkey(value);
                  setAssistantHotkeyConfirmed(true);
                } else {
                  setDictationHotkey(value);
                  setDictationHotkeyConfirmed(true);
                }
              }}
              recommended={assistant ? "CommandOrControl+Shift+Space" : getDefaultHotkey()}
              captureLabel={t("onboarding.rehaul.hotkey.capture")}
              recommendedLabel={t("common.recommended")}
              confirmLabel={(label) => t("onboarding.rehaul.hotkey.confirm", { hotkey: label })}
              chooseAnotherLabel={t("onboarding.rehaul.hotkey.chooseAnother")}
              validate={assistant ? validateAssistantHotkey : validateDictationHotkey}
            />
          </div>
        );
      }

      case "dictation-demo":
      case "assistant-demo": {
        const assistant = currentStepId === "assistant-demo";
        return (
          <div className="w-full">
            <OnboardingStepHeader
              title={t(
                assistant
                  ? "onboarding.rehaul.assistantDemo.title"
                  : "onboarding.rehaul.dictationDemo.title"
              )}
              description={t(
                assistant
                  ? "onboarding.rehaul.assistantDemo.description"
                  : "onboarding.rehaul.dictationDemo.description",
                { hotkey: assistant ? assistantHotkey : dictationHotkey }
              )}
            />
            <DemoStep
              kind={assistant ? "assistant" : "dictation"}
              firstMessage={t(
                assistant
                  ? "onboarding.rehaul.assistantDemo.email"
                  : "onboarding.rehaul.dictationDemo.founder"
              )}
              secondMessage={t(
                assistant
                  ? "onboarding.rehaul.assistantDemo.prompt"
                  : "onboarding.rehaul.dictationDemo.prompt"
              )}
              placeholder={t("onboarding.rehaul.dictationDemo.placeholder")}
              listeningLabel={t("onboarding.rehaul.demo.listening")}
              processingLabel={t("onboarding.rehaul.demo.processing")}
              retryLabel={t("common.retry")}
              assistantResponse={t("onboarding.rehaul.assistantDemo.response")}
              onSuccessChange={assistant ? onAssistantDemoSuccess : onDictationDemoSuccess}
            />
          </div>
        );
      }

      case "notes":
        return (
          <div className="w-full">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.notes.title")}
              description={t("onboarding.rehaul.notes.description")}
            />
            <CalendarConnectionsStep />
          </div>
        );

      case "setup-choice":
        return (
          <div className="w-full">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.setupChoice.title")}
              description={t("onboarding.rehaul.setupChoice.description")}
            />
            <SetupChoiceStep
              isSignedIn={isSignedIn}
              onSelect={(mode) => void handleSetupSelection(mode)}
              onRequestAuthentication={() => {
                setSetupMode("cloud");
                setAuthPath(null);
                goTo("auth");
              }}
            />
          </div>
        );

      case "byok-dictation":
      case "byok-assistant":
        return (
          <div className="w-full">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.provider.title")}
              description={t("onboarding.rehaul.provider.description")}
            />
            <ByokProviderStep stepId={currentStepId} onConnectionChange={onStageReady} />
          </div>
        );

      case "local-dictation":
      case "local-assistant":
        return (
          <div className="w-full">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.local.title")}
              description={t("onboarding.rehaul.local.description")}
            />
            <LocalModelSetupStep stepId={currentStepId} onReadinessChange={onStageReady} />
          </div>
        );

      case "enterprise-dictation":
      case "enterprise-assistant":
        return (
          <div className="w-full">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.enterprise.title")}
              description={t("onboarding.rehaul.enterprise.description")}
            />
            <EnterpriseSetupStep stepId={currentStepId} onConnectionChange={onStageReady} />
          </div>
        );
    }
  };

  const hasShellNavigation = currentStepId !== "auth";
  const localSetup = currentStepId === "local-dictation" || currentStepId === "local-assistant";
  const skippable = currentStepId === "use-cases" || currentStepId === "notes";

  return (
    <>
      <OnboardingShell
        compact={compact}
        onBack={hasShellNavigation && session.history.length > 0 ? goBack : undefined}
        onContinue={hasShellNavigation ? () => void continueFromCurrentStep() : undefined}
        onSkip={
          localSetup
            ? () => void skipLocalSetup()
            : skippable
              ? () => void continueFromCurrentStep()
              : undefined
        }
        continueLabel={t("common.continue")}
        skipLabel={
          localSetup ? t("onboarding.rehaul.local.downloadInBackground") : t("common.skip")
        }
        continueDisabled={!canContinue}
        continueLoading={isFinishing || isRegistering}
        progressIndex={currentStepId === "auth" ? undefined : progressForStep(currentStepId)}
      >
        {fatalError && (
          <div
            role="alert"
            className="fixed left-1/2 top-14 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-destructive/20 bg-card px-4 py-2 text-sm text-destructive shadow-lg"
          >
            <AlertCircle className="size-4" />
            {fatalError}
          </div>
        )}
        {renderStep()}
      </OnboardingShell>

      <AlertDialog
        open={permissionAlert !== null}
        onOpenChange={(open) => !open && setPermissionAlert(null)}
        title={permissionAlert?.title ?? ""}
        description={permissionAlert?.description}
        onOk={() => setPermissionAlert(null)}
      />
    </>
  );
}
