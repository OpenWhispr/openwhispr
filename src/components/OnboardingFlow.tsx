import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import AuthenticationStep from "./AuthenticationStep";
import EmailVerificationStep from "./EmailVerificationStep";
import UseCaseStep from "./onboarding/UseCaseStep";
import { hasUseCaseIntent } from "./onboarding/useCases";
import OnboardingShell, { OnboardingStepHeader } from "./onboarding/OnboardingShell";
import CompactPermissionsStep from "./onboarding/CompactPermissionsStep";
import LanguageSelectionStep from "./onboarding/LanguageSelectionStep";
import ShortcutSetupStep from "./onboarding/ShortcutSetupStep";
import AssistantHotkeyPreview from "./onboarding/AssistantHotkeyPreview";
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
import { getDefaultHotkey, parseHotkeyList, serializeHotkeyList } from "../utils/hotkeys";
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
import { hasPendingLocalModels } from "./onboarding/pendingLocalModels";

interface OnboardingFlowProps {
  onComplete: (options?: { openSettings?: boolean }) => void;
}

const COMPACT_STEPS = new Set<OnboardingStepId>(["auth", "permissions"]);

function progressForStep(stepId: OnboardingStepId): number {
  if (["languages", "assistant-demo", "setup-choice"].includes(stepId)) return 0;
  if (["use-cases", "dictation-demo"].includes(stepId)) return 1;
  if (["dictation-hotkey", "assistant-hotkey"].includes(stepId)) return 2;
  if (stepId === "notes") return 0;
  if (stepId.startsWith("byok-") || stepId.startsWith("local-") || stepId.startsWith("enterprise-"))
    return 0;
  return stepId.endsWith("assistant") ? 1 : 0;
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
  const [, setAccessibilitySkipped] = useLocalStorage(ACCESSIBILITY_SKIPPED_KEY, false);

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
    void window.electronAPI?.setOnboardingActive?.(true);
  }, []);

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

  const confirmDictationHotkey = useCallback(
    async (value: string) => {
      const registered = await registerHotkey(withExtraDictationHotkeys(value));
      return registered ? null : t("onboarding.rehaul.hotkey.inUse");
    },
    [registerHotkey, t, withExtraDictationHotkeys]
  );

  const confirmAssistantHotkey = useCallback(
    async (value: string) => {
      const registered = await settings.setVoiceAgentKey(
        serializeHotkeyList([value, ...parseHotkeyList(settings.voiceAgentKey).slice(1)])
      );
      return registered ? null : t("onboarding.rehaul.hotkey.inUse");
    },
    [settings, t]
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
        // hasPendingLocalModels() covers proceeding past a still-running download
        // rather than skipping: the model was remembered when the download
        // started, and BackgroundModelDownloadTray only applies it (and then
        // clears this flag) while the flag is set.
        if (options.localPending || hasPendingLocalModels())
          localStorage.setItem("localSetupPending", "true");
        else localStorage.removeItem("localSetupPending");
        await window.electronAPI?.saveAllKeysToEnv?.();
        await window.electronAPI?.markBundleMigrated?.();
        clearSession();
        await window.electronAPI?.setOnboardingActive?.(false);
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

  const applyReasoningSelectionToAllScopes = useCallback(
    (mode: "byok" | "local") => {
      // getState(), not the render-time snapshot: the provider steps write
      // chatAgentProvider/chatAgentModel via switchReasoningProvider and call
      // onProceed() in the same tick, so `settingsStore` here still holds the
      // values from before the pick. Reading it stale configured the other three
      // scopes to the defaults (groq / openai/gpt-oss-120b) with no key.
      const { chatAgentProvider, chatAgentModel } = useSettingsStore.getState();
      settingsStore.setCloudReasoningForAllScopes({
        cleanupCloudMode: mode,
        cleanupProvider: chatAgentProvider,
        cleanupModel: chatAgentModel,
        useCleanupModel: true,
        useDictationAgent: true,
      });
    },
    [settingsStore]
  );

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
      if (parseHotkeyList(settings.voiceAgentKey)[0] !== assistantHotkey) {
        const registered = await settings.setVoiceAgentKey(
          serializeHotkeyList([
            assistantHotkey,
            ...parseHotkeyList(settings.voiceAgentKey).slice(1),
          ])
        );
        if (!registered) {
          setFatalError(t("onboarding.rehaul.hotkey.inUse"));
          return;
        }
      }
    } else if (currentStepId === "byok-dictation") {
      settingsStore.setCloudTranscriptionForAllScopes({
        useLocalWhisper: false,
        cloudTranscriptionMode: "byok",
      });
    } else if (currentStepId === "byok-assistant") {
      applyReasoningSelectionToAllScopes("byok");
    } else if (currentStepId === "local-dictation") {
      settingsStore.setCloudTranscriptionForAllScopes({ useLocalWhisper: true });
    } else if (currentStepId === "local-assistant") {
      applyReasoningSelectionToAllScopes("local");
    }

    const next = getNextOnboardingStep(currentStepId, route);
    if (next) {
      goTo(next);
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
    localStorage.setItem("localSetupPending", "true");
    await finalizeOnboarding("local", { localPending: true });
  }, [finalizeOnboarding]);

  const canContinue = (() => {
    switch (currentStepId) {
      case "permissions":
        return areRequiredPermissionsMet(permissions.micPermissionGranted);
      case "languages":
        return settings.spokenLanguages.length > 0;
      case "use-cases":
        return hasUseCaseIntent(settings.onboardingUseCases, settings.onboardingUseCaseNote);
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
          <CompactPermissionsStep
            permissions={permissions}
            systemAudio={systemAudio}
            onContinue={() => void continueFromCurrentStep()}
            onSkip={() => void continueFromCurrentStep()}
          />
        );

      case "languages":
        return (
          <div className="flex h-full min-h-0 w-full flex-col pt-2">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.languages.title")}
              titleLines={[
                t("onboarding.rehaul.languages.titleLineOne"),
                t("onboarding.rehaul.languages.titleLineTwo"),
              ]}
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
          <div className="h-full w-full pt-2">
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
          // Flex column: the preview illustration is allowed to shrink so the
          // capture box below it always stays inside the shell, which is
          // overflow-hidden. Left as a plain block, the fixed 318px preview
          // pushed the capture box off-screen on shorter windows.
          <div className="flex h-full min-h-0 w-full flex-col pt-5">
            <OnboardingStepHeader
              title={t(
                assistant
                  ? "onboarding.rehaul.assistantHotkey.title"
                  : "onboarding.rehaul.dictationHotkey.title"
              )}
              titleLines={
                assistant
                  ? [
                      t("onboarding.rehaul.assistantHotkey.titleLineOne"),
                      t("onboarding.rehaul.assistantHotkey.titleLineTwo"),
                    ]
                  : [
                      t("onboarding.rehaul.dictationHotkey.titleLineOne"),
                      t("onboarding.rehaul.dictationHotkey.titleLineTwo"),
                    ]
              }
              description={t(
                assistant
                  ? "onboarding.rehaul.assistantHotkey.description"
                  : "onboarding.rehaul.dictationHotkey.description"
              )}
            />
            {assistant && <AssistantHotkeyPreview />}
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
              onClearSelection={() => {
                if (assistant) {
                  setAssistantHotkeyConfirmed(false);
                } else {
                  setDictationHotkeyConfirmed(false);
                }
              }}
              recommended={assistant ? "CommandOrControl+Shift+Space" : getDefaultHotkey()}
              captureLabel={t("onboarding.rehaul.hotkey.capture")}
              recommendedLabel={t("common.recommended")}
              chooseAnotherLabel={t("onboarding.rehaul.hotkey.chooseAnother")}
              validate={assistant ? validateAssistantHotkey : validateDictationHotkey}
              onConfirm={assistant ? confirmAssistantHotkey : confirmDictationHotkey}
              dense={assistant}
              showCandidateActions={!assistant}
            />
          </div>
        );
      }

      case "dictation-demo":
      case "assistant-demo": {
        const assistant = currentStepId === "assistant-demo";
        return (
          <div className="h-full w-full pt-5">
            <OnboardingStepHeader
              title={t(
                assistant
                  ? "onboarding.rehaul.assistantDemo.title"
                  : "onboarding.rehaul.dictationDemo.title"
              )}
              titleLines={
                assistant
                  ? [
                      t("onboarding.rehaul.assistantDemo.titleLineOne"),
                      t("onboarding.rehaul.assistantDemo.titleLineTwo"),
                    ]
                  : [
                      t("onboarding.rehaul.dictationDemo.titleLineOne"),
                      t("onboarding.rehaul.dictationDemo.titleLineTwo"),
                    ]
              }
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
              // Only the dictation demo renders this: the assistant card passes
              // secondMessage as its textarea placeholder. The arms used to be
              // crossed, so dictation showed the "Try saying…" prompt it already
              // displays as a chat bubble and the authored placeholder went to the
              // one card that ignores the prop.
              placeholder={t("onboarding.rehaul.dictationDemo.placeholder")}
              listeningLabel={t("onboarding.rehaul.demo.listening")}
              processingLabel={t("onboarding.rehaul.demo.processing")}
              stopLabel={t("onboarding.rehaul.demo.stop")}
              retryLabel={t("common.retry")}
              assistantResponse={t("onboarding.rehaul.assistantDemo.response")}
              assistantSenderName={t("onboarding.rehaul.assistantDemo.senderName")}
              assistantSenderEmail={t("onboarding.rehaul.assistantDemo.senderEmail")}
              assistantRecipientLabel={t("onboarding.rehaul.assistantDemo.recipientLabel")}
              onSuccessChange={assistant ? onAssistantDemoSuccess : onDictationDemoSuccess}
            />
          </div>
        );
      }

      case "notes":
        return (
          // Figma: Onboarding / Frame 50 — column, gap 40, centred; the header
          // block (Frame 29) is its own column at gap 18.
          <div className="flex h-full min-h-0 w-full flex-col items-center gap-10 pt-2">
            <header className="flex w-full shrink-0 flex-col items-center gap-[18px] text-center">
              <h1 className="onboarding-display-title text-[var(--onboarding-text-primary)]">
                <span className="block">{t("onboarding.rehaul.notes.titleLineOne")}</span>
                <span className="block">
                  {t("onboarding.rehaul.notes.titleLineTwoPrefix")}{" "}
                  {/* Caveat sits at the same 40px as the Inter run, per the spec. */}
                  <span className="brand-script">
                    {t("onboarding.rehaul.notes.titleLineTwoBrand")}
                  </span>
                </span>
              </h1>
              <p className="w-[357px] text-base leading-[1.4] text-[var(--onboarding-text-secondary)]">
                {t("onboarding.rehaul.notes.description")}
              </p>
            </header>
            {/* The hero panel and the connector list are both fixed-height, so on
                a short window they run past the footer. The shell never scrolls,
                so the content scrolls here instead — px-1/pb-1 keeps focus rings
                off the clip edge. */}
            <div className="onboarding-shell-scroll min-h-0 w-full flex-1 overflow-y-auto px-1 pb-1">
              <CalendarConnectionsStep />
            </div>
          </div>
        );

      case "setup-choice":
        return (
          <div className="h-full w-full pt-6">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.setupChoice.title")}
              titleLines={[
                t("onboarding.rehaul.setupChoice.titleLineOne"),
                t("onboarding.rehaul.setupChoice.titleLineTwo"),
              ]}
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
          <div className="h-full w-full pt-6">
            <div>
              <OnboardingStepHeader
                title={t("onboarding.rehaul.provider.title")}
                description={t("onboarding.rehaul.provider.description")}
                descriptionLines={[
                  t("onboarding.rehaul.provider.descriptionLineOne"),
                  t("onboarding.rehaul.provider.descriptionLineTwo"),
                ]}
                wideTitle
              />
            </div>
            <ByokProviderStep
              stepId={currentStepId}
              onConnectionChange={onStageReady}
              onProceed={() => void continueFromCurrentStep()}
            />
          </div>
        );

      case "local-dictation":
      case "local-assistant":
        return (
          <div className="h-full w-full pt-6">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.local.title")}
              // Without this the h1 is capped at max-w-xs (320px), which wraps
              // "Set up local models" onto a second line at 40px.
              wideTitle
              description={t("onboarding.rehaul.local.description")}
              descriptionLines={[
                t("onboarding.rehaul.local.descriptionLineOne"),
                t("onboarding.rehaul.local.descriptionLineTwo"),
              ]}
            />
            <LocalModelSetupStep
              stepId={currentStepId}
              onReadinessChange={onStageReady}
              onProceed={() => void continueFromCurrentStep()}
              onSkip={() => void skipLocalSetup()}
            />
          </div>
        );

      case "enterprise-dictation":
      case "enterprise-assistant":
        return (
          <div className="h-full w-full pt-6">
            <OnboardingStepHeader
              title={t("onboarding.rehaul.enterprise.title")}
              description={t("onboarding.rehaul.enterprise.description")}
              descriptionLines={[
                t("onboarding.rehaul.enterprise.descriptionLineOne"),
                t("onboarding.rehaul.enterprise.descriptionLineTwo"),
              ]}
              wideTitle
            />
            <EnterpriseSetupStep
              stepId={currentStepId}
              onConnectionChange={onStageReady}
              onProceed={() => void continueFromCurrentStep()}
            />
          </div>
        );
    }
  };

  const hasShellNavigation = !COMPACT_STEPS.has(currentStepId);
  const hotkeyStep = currentStepId === "dictation-hotkey" || currentStepId === "assistant-hotkey";
  const demoStep = currentStepId === "dictation-demo" || currentStepId === "assistant-demo";
  const inlineGatedStep = hotkeyStep || demoStep;
  const choiceStep = currentStepId === "setup-choice";
  const inlineProviderStep =
    currentStepId === "byok-dictation" ||
    currentStepId === "byok-assistant" ||
    currentStepId === "local-dictation" ||
    currentStepId === "local-assistant" ||
    currentStepId === "enterprise-dictation" ||
    currentStepId === "enterprise-assistant";
  const localSetup = currentStepId === "local-dictation" || currentStepId === "local-assistant";

  return (
    <>
      <OnboardingShell
        compact={compact}
        stepKey={currentStepId}
        onBack={
          hasShellNavigation &&
          currentStepId !== "languages" &&
          !choiceStep &&
          !inlineProviderStep &&
          session.history.length > 0
            ? goBack
            : undefined
        }
        onContinue={
          hasShellNavigation &&
          !choiceStep &&
          !inlineProviderStep &&
          (!inlineGatedStep || canContinue)
            ? () => void continueFromCurrentStep()
            : undefined
        }
        onSkip={localSetup && !inlineProviderStep ? () => void skipLocalSetup() : undefined}
        continueLabel={
          currentStepId === "use-cases"
            ? t("onboarding.useCase.proceedToSetup")
            : t("common.continue")
        }
        skipLabel={
          localSetup ? t("onboarding.rehaul.local.downloadInBackground") : t("common.skip")
        }
        continueDisabled={!canContinue}
        continueLoading={isFinishing || isRegistering}
        progressIndex={compact ? undefined : progressForStep(currentStepId)}
        // On both step families canContinue means "the thing this step asks for
        // is done", so the labelled Back collapses to icon-only the moment a
        // shortcut is confirmed or a demo succeeds.
        showBackLabel={(hotkeyStep || demoStep) && !canContinue}
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
