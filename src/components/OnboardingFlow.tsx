import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  ChevronRight,
  ChevronLeft,
  Check,
  Flag,
  Settings,
  Shield,
  Command,
  Languages,
  Brain,
  Cpu,
  Users,
} from "lucide-react";
import TitleBar from "./TitleBar";
import WindowControls from "./WindowControls";
import PermissionsSection from "./ui/PermissionsSection";
import SupportDropdown from "./ui/SupportDropdown";
import StepProgress from "./ui/StepProgress";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { useSettings } from "../hooks/useSettings";
import { useSettingsStore, selectResolvedLLMConfig, setResolvedLLMConfig } from "../stores/settingsStore";
import LanguageSelector from "./ui/LanguageSelector";
import InferenceConfigEditor from "./settings/InferenceConfigEditor";
import LocalModelSection from "./settings/LocalModelSection";
import { setAgentName as saveAgentName } from "../utils/agentName";
import {
  formatHotkeyLabel,
  getDefaultHotkey,
  isGlobeLikeHotkey,
  parseHotkeyList,
  serializeHotkeyList,
} from "../utils/hotkeys";
import { HotkeyInput } from "./ui/HotkeyInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { useHotkeyModeInfo } from "../hooks/useHotkeyModeInfo";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { getCachedPlatform, getPlatform } from "../utils/platform";
import logger from "../utils/logger";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import TranscriptionModelPicker from "./TranscriptionModelPicker";
import { ACCESSIBILITY_SKIPPED_KEY, areRequiredPermissionsMet } from "../utils/permissions";
import MeetingSetupStep from "./onboarding/MeetingSetupStep";
import FinishStep from "./onboarding/FinishStep";
import { USE_CASE_IDS } from "./onboarding/useCases";


// Highest possible step index across flow variants (skip-auth with meeting step).
const MAX_STEP_INDEX = 7;

// Steps whose primary action is optional — the user can advance without it.
const SKIPPABLE_STEPS = new Set(["meeting"]);

interface OnboardingFlowProps {
  onComplete: (options?: { openSettings?: boolean }) => void;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation();

  const [currentStep, setCurrentStep, removeCurrentStep] = useLocalStorage(
    "onboardingCurrentStep",
    0,
    {
      serialize: String,
      deserialize: (value) => {
        const parsed = parseInt(value, 10);
        // Clamp to valid range to handle users upgrading from older versions
        // with different step counts. The steps array is dynamic, so a second
        // effect below clamps against the actual flow length.
        if (isNaN(parsed) || parsed < 0) return 0;
        return Math.min(parsed, MAX_STEP_INDEX);
      },
    }
  );
  const [accessibilitySkipped, setAccessibilitySkipped] = useLocalStorage(
    ACCESSIBILITY_SKIPPED_KEY,
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    openaiApiKey,
    groqApiKey,
    xaiApiKey,
    mistralApiKey,
    tinfoilApiKey,
    dictationKey,
    meetingKey,
    setMeetingKey,
    voiceAgentKey,
    setVoiceAgentKey,
    activationMode,
    setActivationMode,
    setDictationKey,
    setUseLocalWhisper,
    updateTranscriptionSettings,
    preferredLanguage,
    uiLanguage,
    setUiLanguage,
    onboardingUseCases,
    setOnboardingUseCases,
    onboardingUseCaseNote,
    setOnboardingUseCaseNote,
  } = useSettings();

  const cortiClientId = useSettingsStore((s) => s.cortiClientId);
  const cortiClientSecret = useSettingsStore((s) => s.cortiClientSecret);
  const cleanupMode = useSettingsStore((s) => s.cleanupMode);
  const showLocalModelStep = cleanupMode === "local";

  // Onboarding edits only the primary dictation hotkey; extra bindings are
  // preserved via withExtraDictationHotkeys.
  const [hotkey, setHotkey] = useState(
    () => parseHotkeyList(dictationKey)[0] || getDefaultHotkey()
  );
  const [agentName, setAgentName] = useState("EktosWhispr");
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [startMinimized, setStartMinimized] = useState(false);
  const [isModelDownloaded, setIsModelDownloaded] = useState(false);
  const { isUsingNativeShortcut, isUsingHyprland, hyprlandConfigStatus, supportsPushToTalk } =
    useHotkeyModeInfo("onboarding");
  const readableHotkey = formatHotkeyLabel(hotkey);
  const { alertDialog, confirmDialog, showAlertDialog, hideAlertDialog, hideConfirmDialog } =
    useDialogs();
  const [connectivityDialog, setConnectivityDialog] = useState<{
    open: boolean;
    cause: string;
  }>({ open: false, cause: "" });

  const autoRegisterInFlightRef = useRef(false);
  const hotkeyStepInitializedRef = useRef(false);

  // Replace the primary dictation hotkey while keeping additional bindings intact.
  const withExtraDictationHotkeys = useCallback(
    (primary: string) => serializeHotkeyList([primary, ...parseHotkeyList(dictationKey).slice(1)]),
    [dictationKey]
  );

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setHotkey(parseHotkeyList(registeredHotkey)[0] || registeredHotkey);
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: false,
  });

  const validateHotkeyForInput = useCallback(
    (hotkey: string) => getValidationMessage(hotkey, getPlatform()),
    []
  );

  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog); // Initialize clipboard hook for permission checks

  const systemAudio = useSystemAudioPermission();

  // Wizard always starts with local modes regardless of any stale stored values.
  useEffect(() => {
    const store = useSettingsStore.getState();
    if (!store.useLocalWhisper) {
      store.setUseLocalWhisper(true);
    }
    if (store.cleanupMode !== "local") {
      store.setCleanupMode("local");
    }
  }, []);

  useEffect(() => {
    if (permissionsHook.accessibilityPermissionGranted && accessibilitySkipped) {
      setAccessibilitySkipped(false);
    }
  }, [
    permissionsHook.accessibilityPermissionGranted,
    accessibilitySkipped,
    setAccessibilitySkipped,
  ]);

  // Dynamic flow: signed-in users get permissions folded into "setup".
  // The meeting step is temporarily hidden for all users while it gets more
  // design polish — the step's render code and MeetingSetupStep stay in place.
  // Restore by reinstating the relevance check:
  //   systemAudio.granted || onboardingUseCases.includes(USE_CASE_IDS.meetings)
  const showMeetingStep = false;

  const steps = useMemo(() => {
    const list = [
      { id: "language", title: t("onboarding.steps.language"), icon: Languages },
      { id: "setup", title: t("onboarding.steps.setup"), icon: Settings },
      { id: "languageModel", title: t("onboarding.steps.languageModel"), icon: Brain },
    ];
    if (showLocalModelStep) {
      list.push({ id: "localModel", title: t("onboarding.steps.localModel"), icon: Cpu });
    }
    list.push({ id: "permissions", title: t("onboarding.steps.permissions"), icon: Shield });
    list.push({ id: "activation", title: t("onboarding.steps.activation"), icon: Command });
    if (showMeetingStep) {
      list.push({ id: "meeting", title: t("onboarding.steps.meeting"), icon: Users });
    }
    list.push({ id: "finish", title: t("onboarding.steps.finish"), icon: Flag });
    return list;
  }, [showMeetingStep, showLocalModelStep, t]);

  const currentStepId = steps[currentStep]?.id;

  // The steps array can shrink (e.g. meeting step removed after deselecting
  // meetings on the way back) — keep the index in range.
  useEffect(() => {
    if (currentStep > steps.length - 1) {
      setCurrentStep(steps.length - 1);
    }
  }, [currentStep, steps.length, setCurrentStep]);

  // Only show progress for signed-up users after account creation step
  const showProgress = true;

  useEffect(() => {
    if (isUsingNativeShortcut && !supportsPushToTalk) {
      setActivationMode("tap");
    }
  }, [isUsingNativeShortcut, supportsPushToTalk, setActivationMode]);

  // Update wizard UI when backend falls back to a different hotkey.
  // Only update local state — don't persist to localStorage so the app
  // retries the preferred key on next launch.
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onHotkeyFallbackUsed?.((data: { fallback: string }) => {
      if (data?.fallback) {
        setHotkey(data.fallback);
      }
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    const modelToCheck = localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
    if (!useLocalWhisper || !modelToCheck) {
      setIsModelDownloaded(false);
      return;
    }

    const checkStatus = async () => {
      try {
        const result =
          localTranscriptionProvider === "nvidia"
            ? await window.electronAPI?.checkParakeetModelStatus(modelToCheck)
            : await window.electronAPI?.checkModelStatus(modelToCheck);
        setIsModelDownloaded(result?.downloaded ?? false);
      } catch (error) {
        logger.error("Failed to check model status", { error }, "onboarding");
        setIsModelDownloaded(false);
      }
    };

    checkStatus();
  }, [useLocalWhisper, whisperModel, parakeetModel, localTranscriptionProvider]);

  // Auto-register default hotkey when entering the activation step
  const activationStepIndex = steps.findIndex((step) => step.id === "activation");

  useEffect(() => {
    if (currentStep !== activationStepIndex) {
      // Reset initialization flag when leaving activation step
      hotkeyStepInitializedRef.current = false;
      return;
    }

    // Prevent double-invocation from React.StrictMode
    if (autoRegisterInFlightRef.current || hotkeyStepInitializedRef.current) {
      return;
    }

    const autoRegisterDefaultHotkey = async () => {
      autoRegisterInFlightRef.current = true;
      hotkeyStepInitializedRef.current = true;

      try {
        // Check if backend already registered a hotkey (e.g., KDE D-Bus fallback)
        const backendKey = localStorage.getItem("dictationKey");
        if (backendKey && backendKey.trim() !== "") {
          setHotkey(parseHotkeyList(backendKey)[0] || backendKey);
          setDictationKey(backendKey);
          return;
        }

        // Get platform-appropriate default hotkey from backend (accounts for
        // X11 modifier-only and GNOME gsettings limitations)
        const defaultHotkey =
          (await window.electronAPI?.getEffectiveDefaultHotkey?.()) || getDefaultHotkey();
        const platform = window.electronAPI?.getPlatform?.() ?? "darwin";

        // Only auto-register if no hotkey is currently set
        const shouldAutoRegister =
          !hotkey || hotkey.trim() === "" || (platform !== "darwin" && isGlobeLikeHotkey(hotkey));

        if (shouldAutoRegister) {
          // Try to register the default hotkey silently
          const success = await registerHotkey(defaultHotkey);
          if (success) {
            setHotkey(defaultHotkey);
          }
        }
      } catch (error) {
        logger.error("Failed to auto-register default hotkey", { error }, "onboarding");
      } finally {
        autoRegisterInFlightRef.current = false;
      }
    };

    void autoRegisterDefaultHotkey();
  }, [currentStep, hotkey, registerHotkey, activationStepIndex, setDictationKey]);

  const ensureHotkeyRegistered = useCallback(async () => {
    if (!window.electronAPI?.updateHotkey) {
      return true;
    }

    try {
      const result = await window.electronAPI.updateHotkey(withExtraDictationHotkeys(hotkey));
      if (result && !result.success) {
        showAlertDialog({
          title: t("onboarding.hotkey.couldNotRegisterTitle"),
          description: result.message || t("onboarding.hotkey.couldNotRegisterDescription"),
        });
        return false;
      }
      return true;
    } catch (error) {
      logger.error("Failed to register onboarding hotkey", { error }, "onboarding");
      showAlertDialog({
        title: t("onboarding.hotkey.couldNotRegisterTitle"),
        description: t("onboarding.hotkey.couldNotRegisterDescription"),
      });
      return false;
    }
  }, [hotkey, withExtraDictationHotkeys, showAlertDialog, t]);

  const saveSettings = useCallback(async () => {
    const hotkeyRegistered = await ensureHotkeyRegistered();
    if (!hotkeyRegistered) {
      return false;
    }
    setDictationKey(withExtraDictationHotkeys(hotkey));
    saveAgentName(agentName);

    // Ensure all transcription modes are set to "local" after wizard completion
    const store = useSettingsStore.getState();
    store.setTranscriptionMode("local");
    store.setMeetingTranscriptionMode("local");
    store.setUploadTranscriptionMode("local");

    localStorage.setItem("onboardingCompleted", "true");

    // Fresh install: write the bundle-migration sentinel so the
    // PostMigrationOnboarding modal doesn't fire on next launch.
    // Migrating users skip onboarding entirely (their flag carries over
    // via productName-keyed userData), so they never reach this code.
    void window.electronAPI?.markBundleMigrated?.();

    try {
      await window.electronAPI?.saveAllKeysToEnv?.();
    } catch (error) {
      logger.error("Failed to persist API keys", { error }, "onboarding");
    }

    void window.electronAPI?.setAutoStartEnabled?.(autoStartEnabled);
    useSettingsStore.getState().setStartMinimized(startMinimized);

    window.electronAPI?.downloadWhisperModel?.("base")?.catch?.(() => {});
    window.electronAPI?.modelDownload?.("qwen3.5-2b-q4_k_m")?.catch?.(() => {});

    return true;
  }, [
    hotkey,
    withExtraDictationHotkeys,
    agentName,
    setDictationKey,
    ensureHotkeyRegistered,
    useLocalWhisper,
    updateTranscriptionSettings,
  ]);

  const [isFinishing, setIsFinishing] = useState(false);
  const openSettingsOnCompleteRef = useRef(false);

  const nextStep = useCallback(async () => {
    if (currentStep >= steps.length - 1) {
      return;
    }

    const currentStepId = steps[currentStep]?.id;
    const isPermissionsGate =
      currentStepId === "permissions";
    if (
      getPlatform() === "darwin" &&
      isPermissionsGate &&
      !permissionsHook.accessibilityPermissionGranted
    ) {
      setAccessibilitySkipped(true);
    }

    // When leaving the STT step, mirror the full selection (mode + model + provider) to
    // meeting and upload scopes so the dictation test step already uses the right model.
    if (currentStepId === "setup") {
      const store = useSettingsStore.getState();
      store.setUseLocalWhisper(true);
      store.setMeetingUseLocalWhisper(true);
      store.setUploadUseLocalWhisper(true);
      const selectedProvider = store.localTranscriptionProvider;
      store.setMeetingLocalTranscriptionProvider(selectedProvider);
      store.setUploadLocalTranscriptionProvider(selectedProvider);
      const selectedWhisperModel = store.whisperModel;
      if (selectedWhisperModel) {
        store.setMeetingWhisperModel(selectedWhisperModel);
        store.setUploadWhisperModel(selectedWhisperModel);
      }
      const selectedParakeetModel = store.parakeetModel;
      if (selectedParakeetModel) {
        store.setMeetingParakeetModel(selectedParakeetModel);
        store.setUploadParakeetModel(selectedParakeetModel);
      }
    }

    // When leaving the Language Model step, mirror dictationCleanup config to all other scopes
    if (currentStepId === "languageModel") {
      const cfg = selectResolvedLLMConfig(useSettingsStore.getState(), "dictationCleanup");
      const patch = {
        mode: cfg.mode,
        provider: cfg.provider,
        model: cfg.model,
        cloudMode: cfg.cloudMode,
        cloudBaseUrl: cfg.cloudBaseUrl,
        remoteUrl: cfg.remoteUrl,
      };
      setResolvedLLMConfig("dictationAgent", patch);
      setResolvedLLMConfig("noteFormatting", patch);
      setResolvedLLMConfig("chatIntelligence", patch);
    }

    const newStep = currentStep + 1;
    setCurrentStep(newStep);

    // Show dictation panel when entering activation step
    if (newStep === activationStepIndex) {
      if (window.electronAPI?.showDictationPanel) {
        window.electronAPI.showDictationPanel();
      }
    }
  }, [
    currentStep,
    setCurrentStep,
    steps,
    activationStepIndex,
    onboardingUseCases,
    onboardingUseCaseNote,
    permissionsHook.accessibilityPermissionGranted,
    setAccessibilitySkipped,
    useLocalWhisper,
  ]);

  const prevStep = useCallback(() => {
    if (currentStep > 0) {
      const newStep = currentStep - 1;
      setCurrentStep(newStep);
    }
  }, [currentStep, setCurrentStep]);

  const finishOnboarding = useCallback(
    async (openSettings = false) => {
      openSettingsOnCompleteRef.current = openSettings;
      setIsFinishing(true);
      try {
        const saved = await saveSettings();
        if (!saved) {
          return;
        }

        removeCurrentStep();
        onComplete({ openSettings });
      } finally {
        setIsFinishing(false);
      }
    },
    [saveSettings, removeCurrentStep, onComplete, useLocalWhisper, t]
  );

  const resolveConnectivity = useCallback(
    (useLocal: boolean) => {
      if (useLocal) {
        setUseLocalWhisper(true);
      }
      setConnectivityDialog({ open: false, cause: "" });
      removeCurrentStep();
      onComplete({ openSettings: openSettingsOnCompleteRef.current });
    },
    [setUseLocalWhisper, removeCurrentStep, onComplete]
  );

  const renderStep = () => {
    switch (currentStepId) {
      case "setup":
        return (
          <div className="space-y-3">
            <div className="text-center space-y-0.5">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                {t("onboarding.transcription.title")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("onboarding.transcription.description")}
              </p>
            </div>

            {/* Unified configuration with integrated mode toggle */}
            <TranscriptionModelPicker
              selectedCloudProvider={cloudTranscriptionProvider}
              onCloudProviderSelect={(provider) =>
                updateTranscriptionSettings({ cloudTranscriptionProvider: provider })
              }
              selectedCloudModel={cloudTranscriptionModel}
              onCloudModelSelect={(model) =>
                updateTranscriptionSettings({ cloudTranscriptionModel: model })
              }
              selectedLocalModel={
                localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel
              }
              onLocalModelSelect={(modelId) => {
                if (localTranscriptionProvider === "nvidia") {
                  updateTranscriptionSettings({ parakeetModel: modelId });
                } else {
                  updateTranscriptionSettings({ whisperModel: modelId });
                }
              }}
              selectedLocalProvider={localTranscriptionProvider}
              onLocalProviderSelect={(provider) =>
                updateTranscriptionSettings({
                  localTranscriptionProvider: provider as "whisper" | "nvidia",
                })
              }
              useLocalWhisper={useLocalWhisper}
              onModeChange={(isLocal) => {
                updateTranscriptionSettings({ useLocalWhisper: isLocal });
              }}
              cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
              setCloudTranscriptionBaseUrl={(url) =>
                updateTranscriptionSettings({ cloudTranscriptionBaseUrl: url })
              }
              variant="onboarding"
              mode="local"
            />

          </div>
        );

      case "permissions": {
        const platform = permissionsHook.pasteToolsInfo?.platform;
        const isMacOS = platform === "darwin";

        return (
          <div className="space-y-4">
            {/* Header - compact */}
            <div className="text-center">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                {t("onboarding.permissions.title")}
              </h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isMacOS
                  ? t("onboarding.permissions.requiredForApp")
                  : t("onboarding.permissions.microphoneRequired")}
              </p>
            </div>

            <PermissionsSection
              permissions={permissionsHook}
              systemAudio={systemAudio}
              systemAudioRecommended={onboardingUseCases.includes(USE_CASE_IDS.meetings)}
            />
          </div>
        );
      }

      case "activation":
        return renderActivationStep();

      case "language":
        return renderLanguageStep();

      case "languageModel":
        return (
          <div className="space-y-4">
            <div className="text-center space-y-0.5">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                {t("onboarding.steps.languageModel")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("onboarding.languageModel.description")}
              </p>
            </div>
            <InferenceConfigEditor scope="dictationCleanup" />
          </div>
        );

      case "localModel":
        return (
          <div className="space-y-4">
            <div className="text-center space-y-0.5">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                {t("onboarding.steps.localModel")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("onboarding.localModel.description")}
              </p>
            </div>
            <LocalModelSection />
          </div>
        );

      case "meeting":
        return (
          <MeetingSetupStep
            meetingKey={meetingKey}
            setMeetingKey={setMeetingKey}
            dictationKey={hotkey}
          />
        );

      case "finish":
        return (
          <FinishStep
            isCloudUser={false}
            useCases={onboardingUseCases}
            onFinish={(openSettings) => void finishOnboarding(openSettings)}
            isFinishing={isFinishing}
            autoStartEnabled={autoStartEnabled}
            onAutoStartChange={setAutoStartEnabled}
            startMinimized={startMinimized}
            onStartMinimizedChange={setStartMinimized}
          />
        );

      default:
        return null;
    }
  };

  const renderActivationStep = () => (
    <div className="space-y-4">
      {/* Header */}
      <div className="text-center space-y-0.5">
        <h2 className="text-lg font-semibold text-foreground tracking-tight">
          {t("onboarding.activation.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("onboarding.activation.description")}</p>
      </div>

      {isUsingHyprland && hyprlandConfigStatus && !hyprlandConfigStatus.canWrite && (
        <Alert>
          <AlertTitle>
            {t("settingsPage.general.hotkey.hyprlandConfigWriteWarningTitle")}
          </AlertTitle>
          <AlertDescription>
            {t("settingsPage.general.hotkey.hyprlandConfigWriteWarningDescription", {
              path: hyprlandConfigStatus.path,
            })}
          </AlertDescription>
        </Alert>
      )}

      {/* Unified control surface */}
      <div className="rounded-lg border border-border-subtle bg-surface-1 overflow-hidden">
        {/* Hotkey section */}
        <div className="p-4 border-b border-border-subtle">
          <div className="mb-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t("onboarding.activation.hotkey")}
            </span>
            {isUsingHyprland && (
              <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">
                {t("settingsPage.general.hotkey.hyprlandUnbindDescription")}
              </p>
            )}
          </div>
          <HotkeyInput
            value={hotkey}
            onChange={async (newHotkey) => {
              const success = await registerHotkey(withExtraDictationHotkeys(newHotkey));
              if (success) {
                setHotkey(newHotkey);
              }
            }}
            disabled={isHotkeyRegistering}
            variant="hero"
            validate={validateHotkeyForInput}
          />
        </div>

        {/* Mode section - inline with hotkey */}
        {(!isUsingNativeShortcut || getCachedPlatform() === "linux") && (
          <div className="p-4 flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {t("onboarding.activation.mode")}
              </span>
              <p className="text-xs text-muted-foreground/70 mt-0.5">
                {activationMode === "tap"
                  ? t("onboarding.activation.tapDescription")
                  : t("onboarding.activation.holdDescription")}
              </p>
            </div>
            <ActivationModeSelector value={activationMode} onChange={setActivationMode} />
          </div>
        )}
      </div>

      {/* Test area - minimal chrome */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {t("onboarding.activation.test")}
          </span>
          <span className="text-xs text-muted-foreground/60">
            {activationMode === "tap" || (isUsingNativeShortcut && getCachedPlatform() !== "linux")
              ? t("onboarding.activation.hotkeyToStartStop", { hotkey: readableHotkey })
              : t("onboarding.activation.holdHotkey", { hotkey: readableHotkey })}
          </span>
        </div>
        <Textarea
          rows={2}
          placeholder={t("onboarding.activation.textareaPlaceholder")}
          className="text-sm resize-none"
        />
      </div>
    </div>
  );

  const UI_LANGUAGE_OPTIONS = [
    { value: "en", label: "English", flag: "🇺🇸" },
    { value: "pt", label: "Português", flag: "🇵🇹" },
  ];

  const renderLanguageStep = () => (
    <div className="space-y-4">
      <div className="text-center space-y-0.5">
        <h2 className="text-lg font-semibold text-foreground tracking-tight">
          {t("onboarding.language.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("onboarding.language.description")}</p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5 p-3 bg-muted/50 border border-border/60 rounded">
          <label className="block text-xs font-medium text-muted-foreground">
            {t("onboarding.language.uiLanguageLabel")}
          </label>
          <LanguageSelector
            value={uiLanguage}
            onChange={setUiLanguage}
            options={UI_LANGUAGE_OPTIONS}
            className="w-full"
          />
        </div>

        <div className="space-y-1.5 p-3 bg-muted/50 border border-border/60 rounded">
          <label className="block text-xs font-medium text-muted-foreground">
            {t("onboarding.language.transcriptionLanguageLabel")}
          </label>
          <LanguageSelector
            value={preferredLanguage}
            onChange={(value) => updateTranscriptionSettings({ preferredLanguage: value })}
            multiSelect
            className="w-full"
          />
        </div>
      </div>
    </div>
  );

  const canProceed = () => {
    switch (currentStepId) {
      case "setup":
        if (useLocalWhisper) {
          const modelToCheck =
            localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
          return modelToCheck !== "" && isModelDownloaded;
        } else {
          // For cloud mode, check if appropriate API key is set
          if (cloudTranscriptionProvider === "openai") {
            return openaiApiKey.trim().length > 0;
          } else if (cloudTranscriptionProvider === "groq") {
            return groqApiKey.trim().length > 0;
          } else if (cloudTranscriptionProvider === "xai") {
            return xaiApiKey.trim().length > 0;
          } else if (cloudTranscriptionProvider === "mistral") {
            return mistralApiKey.trim().length > 0;
          } else if (cloudTranscriptionProvider === "corti") {
            return cortiClientId.trim().length > 0 && cortiClientSecret.trim().length > 0;
          } else if (cloudTranscriptionProvider === "tinfoil") {
            return tinfoilApiKey.trim().length > 0;
          } else if (cloudTranscriptionProvider === "custom") {
            // Custom can work without API key for local endpoints
            return true;
          }
          return openaiApiKey.trim().length > 0; // Default to OpenAI
        }
      case "permissions":
        return areRequiredPermissionsMet(permissionsHook.micPermissionGranted);
      case "activation":
        return hotkey.trim() !== "";
      case "language":
        return true;
      case "languageModel":
        return true;
      case "localModel":
        return true;
      case "meeting":
        return true; // Meeting hotkey is optional
      case "finish":
        return true; // FinishStep renders its own actions
      default:
        return false;
    }
  };

  // Load Google Font only in the browser
  React.useEffect(() => {
    const link = document.createElement("link");
    link.href =
      "https://fonts.googleapis.com/css2?family=Noto+Sans:wght@300;400;500;600;700&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, []);

  const onboardingPlatform =
    typeof window !== "undefined" && window.electronAPI?.getPlatform
      ? window.electronAPI.getPlatform()
      : "darwin";

  return (
    <div
      className="h-screen flex flex-col bg-background"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
      />

      <ConfirmDialog
        open={connectivityDialog.open}
        onOpenChange={(open) => !open && setConnectivityDialog({ open: false, cause: "" })}
        title={t("onboarding.connectivity.title")}
        description={t("onboarding.connectivity.body", { cause: connectivityDialog.cause })}
        confirmText={t("onboarding.connectivity.useLocal")}
        cancelText={t("onboarding.connectivity.continue")}
        onConfirm={() => resolveConnectivity(true)}
        onCancel={() => resolveConnectivity(false)}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Title Bar / drag region */}
      {currentStep === 0 ? (
        <div
          className="flex items-center justify-end w-full h-10 shrink-0"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
        >
          {onboardingPlatform !== "darwin" && (
            <div className="pr-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
              <WindowControls />
            </div>
          )}
        </div>
      ) : (
        <div className="shrink-0 z-10">
          <TitleBar
            showTitle={true}
            className="bg-background backdrop-blur-xl border-b border-border shadow-sm"
            actions={<SupportDropdown />}
            center={
              onboardingPlatform === "darwin" ? (
                <StepProgress steps={steps} currentStep={currentStep} />
              ) : undefined
            }
          ></TitleBar>
        </div>
      )}

      {/* Progress bar — on macOS it lives centered in the title bar instead */}
      {showProgress && onboardingPlatform !== "darwin" && (
        <div className="shrink-0 bg-background/80 backdrop-blur-2xl border-b border-white/5 px-6 md:px-12 py-3 z-10">
          <div className="max-w-3xl mx-auto">
            <StepProgress steps={steps} currentStep={currentStep} />
          </div>
        </div>
      )}

      {/* Content - This will grow to fill available space */}
      <div className="flex-1 px-6 md:px-12 overflow-y-auto py-6">
        <div className="w-full max-w-3xl mx-auto">
          <Card className="bg-card border border-border/50 dark:border-white/5 shadow-lg rounded-xl overflow-hidden">
            <CardContent className="p-6 md:p-8">
              {renderStep()}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Footer Navigation - hidden on welcome/auth step */}
      {showProgress && (
        <div className="shrink-0 bg-background/80 backdrop-blur-2xl border-t border-white/5 px-6 md:px-12 py-3 z-10">
          <div className="max-w-3xl mx-auto flex items-center justify-between">
            <Button
              onClick={prevStep}
              variant="outline"
              disabled={currentStep === 0}
              className="h-8 px-5 rounded-full text-xs"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              {t("common.back")}
            </Button>

            <div className="flex items-center gap-2">
              {currentStepId !== "finish" && (
                <>
                  {SKIPPABLE_STEPS.has(currentStepId ?? "") && (
                    <Button
                      onClick={nextStep}
                      variant="ghost"
                      className="h-8 px-4 rounded-full text-xs text-muted-foreground"
                    >
                      {t("common.skip")}
                    </Button>
                  )}
                  <Button
                    onClick={nextStep}
                    disabled={!canProceed()}
                    className="h-8 px-6 rounded-full text-xs"
                  >
                    {t("common.next")}
                    <ChevronRight className="w-3.5 h-3.5" />
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
