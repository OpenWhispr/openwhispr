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
import { usePolicySnapshot } from "../hooks/usePolicy";
import { isAgentAllowed } from "../stores/policyRules";
import { getTranscriptionProviders } from "../models/ModelRegistry";
import { getEnterpriseTranscriptionNeed } from "./onboarding/enterpriseTranscription";
import { useSettingsStore } from "../stores/settingsStore";
import { getDefaultHotkey, parseHotkeyList, serializeHotkeyList } from "../utils/hotkeys";
import { formatHotkeyInstruction } from "./onboarding/hotkeyPresentation";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { validateHotkeyForSlot } from "../utils/hotkeyValidation";
import { getPlatform } from "../utils/platform";
import { ACCESSIBILITY_SKIPPED_KEY, areRequiredPermissionsMet } from "../utils/permissions";
import { cloudPost } from "../services/cloudApi";
import logger from "../utils/logger";
import {
  COMPACT_STEPS,
  getNextOnboardingStep,
  getOnboardingProgress,
  getOnboardingRoute,
  reconcileStepWithRoute,
  type OnboardingSetupMode,
  type OnboardingStepId,
} from "./onboarding/flow";
import { useOnboardingSession } from "./onboarding/useOnboardingSession";
import { clearPendingLocalModels, hasPendingLocalModels } from "./onboarding/pendingLocalModels";

interface OnboardingFlowProps {
  onComplete: (options?: { openSettings?: boolean }) => void;
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
  // Seeded from main rather than getDefaultHotkey(): main already knows when the
  // platform default can't bind (GNOME/X11 reject modifier-only combos) and
  // registered a fallback instead — recommending the unregistrable default would
  // make every confirm of it fail.
  const [recommendedDictationHotkey, setRecommendedDictationHotkey] = useState(getDefaultHotkey);
  const [dictationDemoSuccess, setDictationDemoSuccess] = useState(false);
  const [assistantDemoSuccess, setAssistantDemoSuccess] = useState(false);
  const [stageReady, setStageReady] = useState(false);
  const [selfHostedRequested, setSelfHostedRequested] = useState(false);
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

  const policy = usePolicySnapshot();
  const enterpriseTranscription = useMemo(
    () => getEnterpriseTranscriptionNeed(policy, getTranscriptionProviders()),
    [policy]
  );

  const route = useMemo(
    () =>
      getOnboardingRoute({
        authPath: session.authPath,
        setupMode: session.setupMode,
        agentAllowed,
        enterpriseTranscription,
      }),
    [agentAllowed, enterpriseTranscription, session.authPath, session.setupMode]
  );
  const currentStepId = reconcileStepWithRoute(session.currentStepId, route);
  const compact = COMPACT_STEPS.has(currentStepId);
  // The setup steps after setup-choice, for the stage stepper: the enterprise
  // route can borrow a byok/local transcription step, so the stepper needs the
  // actual route segment rather than the derived two-step pair.
  const setupChoiceIndex = route.indexOf("setup-choice");
  const setupStepIds = setupChoiceIndex >= 0 ? route.slice(setupChoiceIndex + 1) : undefined;

  useEffect(() => {
    if (session.currentStepId !== currentStepId) {
      setSession((current) => ({ ...current, currentStepId }));
    }
  }, [currentStepId, session.currentStepId, setSession]);

  // Cleared on unmount as well as on completion: main fails hotkeys closed while
  // this is set, so an ErrorBoundary catch or a route swap that never comes back
  // would otherwise leave every shortcut dead until the app restarts.
  useEffect(() => {
    void window.electronAPI?.setOnboardingActive?.(true);
    return () => {
      void window.electronAPI?.setOnboardingActive?.(false);
    };
  }, []);

  useEffect(() => {
    void window.electronAPI?.setOnboardingWindowMode?.(compact ? "compact" : "expanded");
  }, [compact]);

  useEffect(() => {
    setStageReady(false);
  }, [currentStepId]);

  // Track main's actual registration: the platform default may be unregistrable
  // (GNOME gsettings and X11 reject modifier-only combos like Control+Super), in
  // which case main silently registered FALLBACK_HOTKEYS instead. Recommend and
  // teach the key that really works, not the one that always errors.
  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      ?.getEffectiveDefaultHotkey?.()
      .then((key) => {
        const effective = key && parseHotkeyList(key)[0];
        if (cancelled || !effective) return;
        setRecommendedDictationHotkey(effective);
        // finalizeOnboarding registers dictationHotkey without further input on
        // routes that never show the hotkey step, so an unregistrable renderer
        // default has to be replaced here, not just in the recommendation.
        setDictationHotkey((current) => (current === getDefaultHotkey() ? effective : current));
      })
      .catch((error) =>
        logger.warn("Failed to read effective default hotkey", { error }, "onboarding")
      );
    const unsubscribe = window.electronAPI?.onHotkeyFallbackUsed?.((data) => {
      const fallback = parseHotkeyList(data?.fallback)[0];
      if (!fallback) return;
      setDictationHotkey(fallback);
      setRecommendedDictationHotkey(fallback);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

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
        //
        // Only preserve a pending download when the completed route still uses
        // local models. Besides the normal local route, this branch can borrow a
        // local transcription stage for enterprise policy. A user who instead
        // walks Back and finishes on Cloud/BYOK must not be switched back to a
        // stale local selection when that download completes later.
        const routeKeepsLocalModels =
          mode === "local" || (mode === "enterprise" && enterpriseTranscription === "local");
        if (routeKeepsLocalModels && (options.localPending || hasPendingLocalModels())) {
          localStorage.setItem("localSetupPending", "true");
        } else {
          localStorage.removeItem("localSetupPending");
          clearPendingLocalModels();
        }
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
      enterpriseTranscription,
      isFinishing,
      onComplete,
      registerHotkey,
      session.authPath,
      t,
      withExtraDictationHotkeys,
    ]
  );

  const applyReasoningSelectionToAllScopes = useCallback(
    (mode: "byok" | "local" | "enterprise") => {
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
    async (mode: Exclude<OnboardingSetupMode, null>, options?: { selfHosted?: boolean }) => {
      setSetupMode(mode);
      setSelfHostedRequested(!!options?.selfHosted);
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
      if (mode === "enterprise" && enterpriseTranscription === "none") {
        // Enterprise setup covers the LLM scopes only; when policy allows the
        // OpenWhispr cloud for speech-to-text, commit it explicitly here — the
        // route has no transcription step, and leaving the defaults in place
        // shipped installs whose transcription mode was never provisioned.
        settingsStore.setCloudTranscriptionForAllScopes({
          useLocalWhisper: false,
          cloudTranscriptionMode: "openwhispr",
          cloudTranscriptionProvider: "openwhispr",
        });
      }
      const nextRoute = getOnboardingRoute({
        authPath: session.authPath,
        setupMode: mode,
        agentAllowed,
        enterpriseTranscription,
      });
      const next = getNextOnboardingStep("setup-choice", nextRoute);
      if (next) goTo(next);
    },
    [
      agentAllowed,
      enterpriseTranscription,
      finalizeOnboarding,
      goTo,
      session.authPath,
      setSetupMode,
      settingsStore,
    ]
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
      // When policy disallows the agent, the byok-assistant step is off-route and
      // no LLM ever gets configured — turn cleanup off so dictations don't route
      // to a default provider with no credential behind it. On the enterprise
      // route this step only provisions transcription; the enterprise steps own
      // the LLM scopes.
      if (session.setupMode === "byok" && !route.includes("byok-assistant")) {
        settingsStore.updateCleanupSettings({ useCleanupModel: false });
      }
    } else if (currentStepId === "byok-assistant") {
      applyReasoningSelectionToAllScopes("byok");
    } else if (currentStepId === "local-dictation") {
      settingsStore.setCloudTranscriptionForAllScopes({ useLocalWhisper: true });
      // Same policy-shortened-route case as byok: no local LLM was downloaded, so
      // cleanup must not silently fall back to a cloud default. Not on the
      // enterprise route, where the enterprise steps configure the LLM scopes.
      if (session.setupMode === "local" && !route.includes("local-assistant")) {
        settingsStore.updateCleanupSettings({ useCleanupModel: false });
      }
    } else if (currentStepId === "local-assistant") {
      applyReasoningSelectionToAllScopes("local");
    } else if (currentStepId === "enterprise-dictation") {
      // With the agent disallowed the enterprise-assistant step never runs, yet
      // the managed policy still expects the LLM scopes on the enterprise
      // provider (getManagedScopeResolution rescues managed configs at resolve
      // time, but manual setups are used as-is) — apply it from here instead.
      if (!route.includes("enterprise-assistant")) {
        applyReasoningSelectionToAllScopes("enterprise");
      }
    } else if (currentStepId === "enterprise-assistant") {
      // "enterprise" is not one of TRANSCRIPTION_POLICY_CATALOG.modes, so it
      // governs the LLM scopes only — speech-to-text was provisioned upstream
      // (openwhispr commit in handleSetupSelection, or the borrowed
      // byok/local-dictation step on this route). Without this, cleanup and
      // note formatting keep their default provider and model with no
      // credential behind them.
      applyReasoningSelectionToAllScopes("enterprise");
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
    // On the enterprise route the local-dictation step is a borrowed
    // transcription stage; skipping a still-running download must continue to
    // the enterprise steps, not end onboarding. finalizeOnboarding's
    // hasPendingLocalModels() check re-arms the marker at the end of the route.
    if (session.setupMode === "enterprise") {
      localStorage.setItem("localSetupPending", "true");
      await continueFromCurrentStep();
      return;
    }
    await finalizeOnboarding("local", { localPending: true });
  }, [continueFromCurrentStep, finalizeOnboarding, session.setupMode]);

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
                  // Guests continue onto their route's permissions step — jumping
                  // straight to setup-choice would skip the permission grants and
                  // hotkey the guest route exists to guarantee (see flow.ts).
                  setAuthPath("guest");
                  goTo("permissions");
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
              recommended={assistant ? "CommandOrControl+Shift+Space" : recommendedDictationHotkey}
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
                // Formatted for reading: the raw accelerator would show internal
                // syntax like "GLOBE" or "CommandOrControl+Shift+Space".
                { hotkey: formatHotkeyInstruction(assistant ? assistantHotkey : dictationHotkey) }
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
              // secondMessage as its textarea placeholder.
              placeholder={t("onboarding.rehaul.dictationDemo.placeholder")}
              listeningLabel={t("onboarding.rehaul.demo.listening")}
              processingLabel={t("onboarding.rehaul.demo.processing")}
              stopLabel={t("onboarding.rehaul.demo.stop")}
              retryLabel={t("common.retry")}
              assistantResponse={t("onboarding.rehaul.assistantDemo.response")}
              assistantSenderName={t("onboarding.rehaul.assistantDemo.senderName")}
              assistantSenderEmail={t("onboarding.rehaul.assistantDemo.senderEmail")}
              assistantRecipientLabel={t("onboarding.rehaul.assistantDemo.recipientLabel")}
              onSuccessChange={assistant ? setAssistantDemoSuccess : setDictationDemoSuccess}
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
              onSelect={(mode, options) => void handleSetupSelection(mode, options)}
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
              stepIds={setupStepIds}
              selfHostedRequested={
                selfHostedRequested ||
                (session.setupMode === "enterprise" && enterpriseTranscription === "self-hosted")
              }
              onConnectionChange={setStageReady}
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
              stepIds={setupStepIds}
              onReadinessChange={setStageReady}
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
              stepIds={setupStepIds}
              onConnectionChange={setStageReady}
              onProceed={() => void continueFromCurrentStep()}
              onRequestAuthentication={() => {
                setAuthPath(null);
                goTo("auth");
              }}
            />
          </div>
        );
    }
  };

  const hasShellNavigation = !compact;
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
  // Choice/provider pages own their forward action, while hotkey/demo pages
  // withhold Continue until their task is complete.
  const showsContinue =
    hasShellNavigation && !choiceStep && !inlineProviderStep && (!inlineGatedStep || canContinue);
  // Keep this branch's demo escape hatch: practice must remain skippable when a
  // microphone or backend problem prevents completion.
  const showsSkip = demoStep && !canContinue;

  return (
    <>
      <OnboardingShell
        compact={compact}
        stepKey={currentStepId}
        // History is the only Back gate. This preserves the branch's provider
        // escape path and also lets users return from setup choice/languages.
        onBack={hasShellNavigation && session.history.length > 0 ? goBack : undefined}
        onContinue={showsContinue ? () => void continueFromCurrentStep() : undefined}
        // The demos are practice, not configuration — a mic problem or an
        // unreachable transcription backend must never dead-end setup, so they
        // stay skippable until they succeed.
        onSkip={showsSkip ? () => void continueFromCurrentStep() : undefined}
        continueLabel={
          currentStepId === "use-cases"
            ? t("onboarding.useCase.proceedToSetup")
            : t("common.continue")
        }
        skipLabel={t("common.skip")}
        continueDisabled={!canContinue}
        continueLoading={isFinishing || isRegistering}
        progress={getOnboardingProgress(currentStepId, route)}
        // Label Back only when it is the sole footer action. Unlike the source
        // commit, this branch also has demo Skip, so Back stays icon-only there.
        showBackLabel={!showsContinue && !showsSkip}
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
