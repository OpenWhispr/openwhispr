import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { CompactAuthenticationFlow } from "./CompactAuthenticationFlow";
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
import { ByokProviderStep, LocalModelSetupStep } from "./onboarding/ProviderSetupStep";
import { RequiredModelDownloadStep } from "./onboarding/RequiredModelDownloadStep";
import { AlertDialog } from "./ui/dialog";
import { useAuth } from "../hooks/useAuth";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useScreenRecordingPermission } from "../hooks/useScreenRecordingPermission";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { useSettings } from "../hooks/useSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { useHotkeyModeInfo } from "../hooks/useHotkeyModeInfo";
import { useWorkspace } from "../hooks/useWorkspace";
import { useRequiredLocalModels } from "../hooks/useRequiredLocalModels";
import { usePolicyStore } from "../stores/policyStore";
import { isAgentAllowed, isScreenContextAllowed } from "../stores/policyRules";
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
  resolveEnterpriseWorkspaceForOnboarding,
  shouldSkipOnboardingSetupChoice,
  type OnboardingSetupMode,
  type OnboardingStepId,
} from "./onboarding/flow";
import { useOnboardingSession } from "./onboarding/useOnboardingSession";
import { clearPendingLocalModels, hasPendingLocalModels } from "./onboarding/pendingLocalModels";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import LinuxPttSetupInfo from "./ui/LinuxPttSetupInfo";

interface OnboardingFlowProps {
  onComplete: (options?: { openSettings?: boolean }) => void;
}

type OnboardingCompletionMode = Exclude<OnboardingSetupMode, null> | "managed";

function DemoHotkeyDescription({ text, hotkey }: { text: string; hotkey: string }) {
  const hotkeyStart = text.indexOf(hotkey);
  if (hotkeyStart < 0) return text;

  return (
    <>
      {text.slice(0, hotkeyStart)}
      <kbd className="mx-0.5 inline-flex rounded-md bg-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] px-1.5 py-0.5 font-semibold text-[var(--onboarding-accent)]">
        {hotkey}
      </kbd>
      {text.slice(hotkeyStart + hotkey.length)}
    </>
  );
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation();
  const { isSignedIn } = useAuth();
  const agentAllowed = usePolicyStore(isAgentAllowed);
  const screenContextAllowed = usePolicyStore(isScreenContextAllowed);
  const settings = useSettings();
  const settingsStore = useSettingsStore();
  const {
    session,
    setSession,
    goTo,
    goBack,
    setAuthPath,
    setSetupMode,
    setSelfHostedRequested,
    clearSession,
  } = useOnboardingSession();

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
  const {
    granted: screenRecordingGranted,
    needsRelaunch: screenRecordingNeedsRelaunch,
    request: requestScreenRecordingAccess,
  } = useScreenRecordingPermission();
  const { supportsPushToTalk, pushToTalkUnavailableReason } = useHotkeyModeInfo(
    "onboarding",
    dictationHotkey
  );
  const { activationMode, setActivationMode } = settings;
  // This hook also starts the membership fetch for already-authenticated users;
  // relying on the login transition alone would leave resumed onboarding stuck
  // waiting for workspace resolution after an app restart.
  const {
    active: activeWorkspace,
    workspaces,
    loaded: workspacesLoaded,
    setActive: setActiveWorkspace,
  } = useWorkspace();
  const enterpriseWorkspace = useMemo(
    () => resolveEnterpriseWorkspaceForOnboarding(activeWorkspace, workspaces),
    [activeWorkspace, workspaces]
  );
  const skipSetupChoiceForEnterprise = shouldSkipOnboardingSetupChoice({
    isSignedIn,
    authPath: session.authPath,
    setupMode: session.setupMode,
    activeWorkspace: enterpriseWorkspace,
  });

  useEffect(() => {
    if (
      workspacesLoaded &&
      !activeWorkspace &&
      skipSetupChoiceForEnterprise &&
      enterpriseWorkspace
    ) {
      setActiveWorkspace(enterpriseWorkspace.id);
    }
  }, [
    activeWorkspace,
    enterpriseWorkspace,
    setActiveWorkspace,
    skipSetupChoiceForEnterprise,
    workspacesLoaded,
  ]);

  const workspaceResolutionPending =
    isSignedIn &&
    session.authPath === "account" &&
    (!workspacesLoaded ||
      (!activeWorkspace && skipSetupChoiceForEnterprise && Boolean(enterpriseWorkspace)));

  // The setting turns on only once the permission is actually granted, so an
  // Enable click whose System Settings grant is abandoned can't leave screen
  // context armed to activate silently on some later grant.
  const [screenContextRequested, setScreenContextRequested] = useState(false);

  const applyScreenContext = useCallback(() => {
    settingsStore.setVoiceAgentScreenContext(true);
    // Keeps the dictation overlay out of its own screenshots.
    void window.electronAPI?.setScreenContextEnabled?.(true);
  }, [settingsStore]);

  const enableScreenContext = useCallback(async () => {
    setScreenContextRequested(true);
    const granted = await requestScreenRecordingAccess();
    if (granted) applyScreenContext();
    return granted;
  }, [applyScreenContext, requestScreenRecordingAccess]);

  // macOS grants Screen Recording in System Settings, outside the app; the
  // permission hook re-checks on window focus. When the grant lands, complete
  // the opt-in the Enable click started — within this session only.
  useEffect(() => {
    if (!screenContextRequested || !screenRecordingGranted) return;
    if (settingsStore.voiceAgentScreenContext) return;
    applyScreenContext();
  }, [
    screenContextRequested,
    screenRecordingGranted,
    settingsStore.voiceAgentScreenContext,
    applyScreenContext,
  ]);

  const requiredModels = useRequiredLocalModels();
  // Latched for the session once the step is entered (or resumed at), so a
  // mid-download policy refresh or the disk check settling can't rebuild the
  // route out from under the user. Seeded from the persisted session because
  // relaunching mid-download must resume on the step, not bounce off it while
  // the disk check is still pending.
  const requiredModelsLatchRef = useRef(session.currentStepId === "required-models");
  const requiredModelsPending = requiredModelsLatchRef.current || requiredModels.missing.length > 0;

  const route = useMemo(
    () =>
      getOnboardingRoute({
        authPath: session.authPath,
        setupMode: session.setupMode,
        agentAllowed,
        requiredModelsPending,
        skipSetupChoice: skipSetupChoiceForEnterprise,
      }),
    [
      agentAllowed,
      requiredModelsPending,
      session.authPath,
      session.setupMode,
      skipSetupChoiceForEnterprise,
    ]
  );
  const currentStepId = reconcileStepWithRoute(session.currentStepId, route);
  const compact = COMPACT_STEPS.has(currentStepId);

  useEffect(() => {
    if (currentStepId === "required-models") requiredModelsLatchRef.current = true;
  }, [currentStepId]);

  // The auth step lands on "permissions" before the policy and disk checks
  // settle (AppRouter's policy gate remounts this component mid-transition),
  // so a persisted session can sit one step past the gate when the pending
  // flag arrives. Pull the user back — only from permissions, the immediate
  // post-auth screen, and only before the step was entered this session.
  useEffect(() => {
    if (
      requiredModelsPending &&
      currentStepId === "permissions" &&
      !requiredModelsLatchRef.current &&
      route.includes("required-models")
    ) {
      goTo("required-models");
    }
  }, [currentStepId, goTo, requiredModelsPending, route]);

  useEffect(() => {
    if (session.currentStepId !== currentStepId) {
      setSession((current) => ({ ...current, currentStepId }));
    }
  }, [currentStepId, session.currentStepId, setSession]);

  // AppRouter releases this only after it has committed the normal app. Keeping
  // the gate active across this component's unmount prevents a one-frame flash
  // of the dictation pill or another normal-app overlay at completion/error.
  useEffect(() => {
    void window.electronAPI?.setOnboardingActive?.(true);
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
      spokenLanguages: settings.spokenLanguages,
    }).catch((error) => logger.warn("Failed to sync onboarding intent", { error }, "onboarding"));
  }, [
    isSignedIn,
    session.authPath,
    settings.onboardingUseCaseNote,
    settings.onboardingUseCases,
    settings.spokenLanguages,
  ]);

  const finalizeOnboarding = useCallback(
    async (mode: OnboardingCompletionMode, options: { localPending?: boolean } = {}) => {
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

        await window.electronAPI?.saveAllKeysToEnv?.();
        await window.electronAPI?.markBundleMigrated?.();
        await window.electronAPI?.setOnboardingWindowMode?.("restore");

        // hasPendingLocalModels() covers proceeding past a still-running download
        // rather than skipping: the model was remembered when the download
        // started, and BackgroundModelDownloadTray only applies it (and then
        // clears this flag) while the flag is set.
        //
        // Only preserve a pending download when the completed route still uses
        // local models. A user who walks Back and finishes on Cloud/BYOK must not
        // be switched back to a stale local selection when it completes later.
        const routeKeepsLocalModels = mode === "local";
        if (routeKeepsLocalModels && (options.localPending || hasPendingLocalModels())) {
          localStorage.setItem("localSetupPending", "true");
        } else {
          localStorage.removeItem("localSetupPending");
          clearPendingLocalModels();
        }

        const skippedAuth = session.authPath === "guest";
        localStorage.setItem("authenticationSkipped", String(skippedAuth));
        localStorage.setItem("skipAuth", String(skippedAuth));
        clearSession();
        localStorage.setItem("onboardingCompleted", "true");
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

  // Sessions saved on the old setup-choice step reconcile back to Notes once an
  // Enterprise workspace is confirmed. Finish them without writing provider or
  // model settings, just as if Notes had been their final step originally.
  useEffect(() => {
    if (!skipSetupChoiceForEnterprise || session.currentStepId !== "setup-choice" || isFinishing) {
      return;
    }
    void finalizeOnboarding("managed");
  }, [finalizeOnboarding, isFinishing, session.currentStepId, skipSetupChoiceForEnterprise]);

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
    async (mode: Exclude<OnboardingSetupMode, null>, options?: { selfHosted?: boolean }) => {
      setSetupMode(mode);
      setSelfHostedRequested(!!options?.selfHosted);
      if (mode === "cloud") {
        settingsStore.setCloudTranscriptionForAllScopes({
          useLocalWhisper: false,
          cloudTranscriptionMode: "openwhispr",
          cloudTranscriptionProvider: "openwhispr",
        });
        if (agentAllowed) {
          settingsStore.setCloudReasoningForAllScopes({
            cleanupCloudMode: "openwhispr",
            cleanupProvider: "openwhispr",
          });
        } else {
          // The policy-shortened route has no assistant setup. Avoid persisting
          // a reasoning provider the workspace disallows, and keep dictation
          // from attempting cleanup through an unconfigured LLM.
          settingsStore.updateCleanupSettings({ useCleanupModel: false });
        }
        await finalizeOnboarding("cloud");
        return;
      }
      const nextRoute = getOnboardingRoute({
        authPath: session.authPath,
        setupMode: mode,
        agentAllowed,
        requiredModelsPending,
      });
      const next = getNextOnboardingStep("setup-choice", nextRoute);
      if (next) goTo(next);
    },
    [
      agentAllowed,
      finalizeOnboarding,
      goTo,
      requiredModelsPending,
      session.authPath,
      setSelfHostedRequested,
      setSetupMode,
      settingsStore,
    ]
  );

  const continueFromCurrentStep = useCallback(async () => {
    // A banner from an earlier failed attempt must not outlive the retry.
    setFatalError(null);
    if (currentStepId === "notes" && workspaceResolutionPending) return;
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
      // When policy disallows the agent, the assistant step is off-route and no
      // LLM gets configured. Turn cleanup off so dictations do not route to a
      // default provider with no credential behind it.
      if (!route.includes("byok-assistant")) {
        settingsStore.updateCleanupSettings({ useCleanupModel: false });
      }
    } else if (currentStepId === "byok-assistant") {
      applyReasoningSelectionToAllScopes("byok");
    } else if (currentStepId === "local-dictation") {
      settingsStore.setCloudTranscriptionForAllScopes({ useLocalWhisper: true });
      // Same policy-shortened-route case as BYOK: no local LLM was downloaded,
      // so cleanup must not silently fall back to a cloud default.
      if (!route.includes("local-assistant")) {
        settingsStore.updateCleanupSettings({ useCleanupModel: false });
      }
    } else if (currentStepId === "local-assistant") {
      applyReasoningSelectionToAllScopes("local");
    }

    const next = getNextOnboardingStep(currentStepId, route);
    if (next) {
      goTo(next);
      return;
    }

    if (skipSetupChoiceForEnterprise) {
      await finalizeOnboarding("managed");
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
    workspaceResolutionPending,
    skipSetupChoiceForEnterprise,
  ]);

  const skipLocalSetup = useCallback(async () => {
    if (currentStepId === "local-dictation") {
      await continueFromCurrentStep();
      return;
    }
    await finalizeOnboarding("local", { localPending: true });
  }, [continueFromCurrentStep, currentStepId, finalizeOnboarding]);

  const canContinue = (() => {
    switch (currentStepId) {
      case "required-models":
        return !requiredModels.loading && requiredModels.missing.length === 0;
      case "permissions":
        return areRequiredPermissionsMet(permissions.micPermissionGranted);
      case "languages":
        return settings.spokenLanguages.length > 0;
      case "use-cases":
        return hasUseCaseIntent(settings.onboardingUseCases, settings.onboardingUseCaseNote);
      case "dictation-hotkey":
        return dictationHotkeyConfirmed;
      case "activation-mode":
        return true;
      case "dictation-demo":
        return dictationDemoSuccess;
      case "assistant-hotkey":
        return assistantHotkeyConfirmed;
      case "assistant-demo":
        return assistantDemoSuccess;
      case "notes":
        return !workspaceResolutionPending;
      case "byok-dictation":
      case "byok-assistant":
      case "local-dictation":
      case "local-assistant":
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
            <CompactAuthenticationFlow
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
            />
          </div>
        );

      case "required-models":
        return (
          <div className="h-full w-full pt-2">
            <OnboardingStepHeader
              title={t("onboarding.requiredModels.title")}
              wideTitle
              description={t("onboarding.requiredModels.description", {
                organization:
                  activeWorkspace?.name ?? t("onboarding.requiredModels.genericOrganization"),
              })}
            />
            <RequiredModelDownloadStep
              required={requiredModels.required}
              missing={requiredModels.missing}
              loading={requiredModels.loading}
              refresh={requiredModels.refresh}
              onProceed={() => void continueFromCurrentStep()}
            />
          </div>
        );

      case "permissions":
        return (
          <CompactPermissionsStep
            permissions={permissions}
            systemAudio={systemAudio}
            screenContext={
              agentAllowed && screenContextAllowed
                ? {
                    enabled: settingsStore.voiceAgentScreenContext,
                    granted: screenRecordingGranted,
                    needsRelaunch: screenRecordingNeedsRelaunch,
                    request: enableScreenContext,
                  }
                : undefined
            }
            onContinue={() => void continueFromCurrentStep()}
          />
        );

      case "languages":
        return (
          <div className="flex h-full min-h-0 w-full flex-col pt-1">
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
          <div className="h-full w-full pt-1">
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
          // overflow-hidden.
          <div className="flex h-full min-h-0 w-full flex-col pt-2">
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

      case "activation-mode":
        return (
          <div className="flex h-full min-h-0 w-full flex-col pt-2">
            <OnboardingStepHeader
              title={t("onboarding.activation.title")}
              description={t("onboarding.activation.description")}
            />
            <div className="mx-auto mt-10 w-full max-w-md rounded-2xl border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] p-5">
              <div className="flex items-center justify-between gap-5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--onboarding-text-primary)]">
                    {t("onboarding.activation.mode")}
                  </p>
                  <p className="mt-1 text-sm text-[var(--onboarding-text-secondary)]">
                    {t(
                      activationMode === "push"
                        ? "onboarding.activation.holdDescription"
                        : "onboarding.activation.tapDescription"
                    )}
                  </p>
                </div>
                <ActivationModeSelector
                  value={activationMode}
                  onChange={setActivationMode}
                  pushDisabledReason={
                    !supportsPushToTalk
                      ? pushToTalkUnavailableReason || t("windows.pttUnavailable")
                      : undefined
                  }
                />
              </div>
              {getPlatform() === "linux" && activationMode === "push" && (
                <LinuxPttSetupInfo isAvailable={supportsPushToTalk} />
              )}
            </div>
          </div>
        );

      case "dictation-demo":
      case "assistant-demo": {
        const assistant = currentStepId === "assistant-demo";
        const hotkeyInstruction = formatHotkeyInstruction(
          assistant ? assistantHotkey : dictationHotkey
        );
        const description = t(
          assistant
            ? "onboarding.rehaul.assistantDemo.description"
            : activationMode === "push"
              ? "onboarding.activation.holdHotkey"
              : "onboarding.rehaul.dictationDemo.description",
          // Formatted for reading: the raw accelerator would show internal
          // syntax like "GLOBE" or "CommandOrControl+Shift+Space".
          { hotkey: hotkeyInstruction }
        );
        return (
          <div className="h-full w-full pt-2">
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
              description={
                assistant ? (
                  description
                ) : (
                  <DemoHotkeyDescription text={description} hotkey={hotkeyInstruction} />
                )
              }
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
          // Compact centred column; the calendar body owns short-window scrolling.
          <div className="flex h-full min-h-0 w-full flex-col items-center gap-5 pt-1">
            <header className="flex w-full shrink-0 flex-col items-center gap-3 text-center">
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
              <p className="w-full max-w-xs text-sm leading-[1.5] text-[var(--onboarding-text-secondary)]">
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
          <div className="h-full w-full pt-2">
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
              agentAllowed={agentAllowed}
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
          <div className="h-full w-full pt-2">
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
              selfHostedRequested={session.selfHostedRequested}
              onSelfHostedChange={setSelfHostedRequested}
              onConnectionChange={setStageReady}
              onProceed={() => void continueFromCurrentStep()}
            />
          </div>
        );

      case "local-dictation":
      case "local-assistant":
        return (
          <div className="h-full w-full pt-2">
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
              onReadinessChange={setStageReady}
              onProceed={() => void continueFromCurrentStep()}
              onSkip={() => void skipLocalSetup()}
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
    currentStepId === "local-assistant";
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
        // The required-models step is the exception: it is an org-mandated
        // blocker, so backing out of it (to auth) is suppressed.
        onBack={
          hasShellNavigation && session.history.length > 0 && currentStepId !== "required-models"
            ? goBack
            : undefined
        }
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
        continueLoading={
          isFinishing || isRegistering || (currentStepId === "notes" && workspaceResolutionPending)
        }
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
