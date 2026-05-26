import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  ChevronRight,
  ChevronLeft,
  Check,
  Settings,
  Shield,
  Command,
  UserCircle,
  Loader2,
  AlertTriangle,
  Sliders,
  LogOut,
} from "lucide-react";
import TitleBar from "./TitleBar";
import PermissionsSection from "./ui/PermissionsSection";
import StepProgress from "./ui/StepProgress";
import { AlertDialog, ConfirmDialog } from "./ui/dialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useDialogs } from "../hooks/useDialogs";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useSystemAudioPermission } from "../hooks/useSystemAudioPermission";
import { useSettings } from "../hooks/useSettings";
import LanguageSelector from "./ui/LanguageSelector";
import { useCortiAccount } from "../hooks/useCortiAccount";
import { Input } from "./ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Toggle } from "./ui/toggle";
import { cn } from "./lib/utils";
import { useSettingsStore } from "../stores/settingsStore";
import { setAgentName as saveAgentName } from "../utils/agentName";
import { formatHotkeyLabel, getDefaultHotkey, isGlobeLikeHotkey } from "../utils/hotkeys";
import { HotkeyInput } from "./ui/HotkeyInput";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { getCachedPlatform, getPlatform } from "../utils/platform";
import logger from "../utils/logger";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import { ACCESSIBILITY_SKIPPED_KEY, areRequiredPermissionsMet } from "../utils/permissions";

interface OnboardingFlowProps {
  onComplete: () => void;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { t } = useTranslation();

  const getMaxStep = () => 3;

  const [currentStep, setCurrentStep, removeCurrentStep] = useLocalStorage(
    "onboardingCurrentStep",
    0,
    {
      serialize: String,
      deserialize: (value) => {
        const parsed = parseInt(value, 10);
        // Clamp to valid range to handle users upgrading from older versions
        // with different step counts
        if (isNaN(parsed) || parsed < 0) return 0;
        const maxStep = getMaxStep();
        if (parsed > maxStep) return maxStep;
        return parsed;
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
    dictationKey,
    activationMode,
    setActivationMode,
    setDictationKey,
    updateTranscriptionSettings,
    preferredLanguage,
  } = useSettings();

  const [hotkey, setHotkey] = useState(dictationKey || getDefaultHotkey());
  const [agentName, setAgentName] = useState("OpenWhispr");
  const [isUsingNativeShortcut, setIsUsingNativeShortcut] = useState(false);
  const readableHotkey = formatHotkeyLabel(hotkey);
  const { alertDialog, confirmDialog, showAlertDialog, hideAlertDialog, hideConfirmDialog } =
    useDialogs();
  const autoRegisterInFlightRef = useRef(false);
  const hotkeyStepInitializedRef = useRef(false);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setHotkey(registeredHotkey);
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

  useEffect(() => {
    if (permissionsHook.accessibilityPermissionGranted && accessibilitySkipped) {
      setAccessibilitySkipped(false);
    }
  }, [
    permissionsHook.accessibilityPermissionGranted,
    accessibilitySkipped,
    setAccessibilitySkipped,
  ]);

  const steps = useMemo(
    () => [
      {
        id: "corti",
        title: t("onboarding.steps.corti", "Sign in"),
        icon: UserCircle,
      },
      {
        id: "language",
        title: t("onboarding.steps.language", "Language"),
        icon: Settings,
      },
      { id: "permissions", title: t("onboarding.steps.permissions"), icon: Shield },
      { id: "activation", title: t("onboarding.steps.activation"), icon: Command },
    ],
    [t]
  );

  const showProgress = true;

  useEffect(() => {
    const checkHotkeyMode = async () => {
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo();
        if (info?.isUsingNativeShortcut) {
          setIsUsingNativeShortcut(true);
          if (!info.supportsPushToTalk) {
            setActivationMode("tap");
          }
        }
      } catch (error) {
        logger.error("Failed to check hotkey mode", { error }, "onboarding");
      }
    };
    checkHotkeyMode();
  }, [setActivationMode]);

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

  // Auto-register default hotkey when entering the activation step
  const activationStepIndex = 3;

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
          setHotkey(backendKey);
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
      const result = await window.electronAPI.updateHotkey(hotkey);
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
  }, [hotkey, showAlertDialog, t]);

  const saveSettings = useCallback(async () => {
    const hotkeyRegistered = await ensureHotkeyRegistered();
    if (!hotkeyRegistered) {
      return false;
    }
    setDictationKey(hotkey);
    saveAgentName(agentName);

    localStorage.setItem("onboardingCompleted", "true");

    // Fresh install: write the bundle-migration sentinel so the
    // PostMigrationOnboarding modal doesn't fire on next launch.
    void window.electronAPI?.markBundleMigrated?.();

    try {
      await window.electronAPI?.saveAllKeysToEnv?.();
    } catch (error) {
      logger.error("Failed to persist API keys", { error }, "onboarding");
    }

    return true;
  }, [hotkey, agentName, setDictationKey, ensureHotkeyRegistered]);

  const nextStep = useCallback(async () => {
    if (currentStep >= steps.length - 1) {
      return;
    }

    const currentStepId = steps[currentStep]?.id;
    if (
      getPlatform() === "darwin" &&
      currentStepId === "permissions" &&
      !permissionsHook.accessibilityPermissionGranted
    ) {
      setAccessibilitySkipped(true);
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
    permissionsHook.accessibilityPermissionGranted,
    setAccessibilitySkipped,
  ]);

  const prevStep = useCallback(() => {
    if (currentStep > 0) {
      const newStep = currentStep - 1;
      setCurrentStep(newStep);
    }
  }, [currentStep, setCurrentStep]);

  const finishOnboarding = useCallback(async () => {
    const saved = await saveSettings();
    if (!saved) {
      return;
    }
    removeCurrentStep();
    onComplete();
  }, [saveSettings, removeCurrentStep, onComplete]);

  const renderStep = () => {
    switch (currentStep) {
      case 0: // Corti sign-in
        return <CortiLoginStep />;

      case 1: // Language
        return (
          <div className="space-y-3">
            <div className="text-center space-y-0.5">
              <h2 className="text-lg font-semibold text-foreground tracking-tight">
                {t("onboarding.language.title", "Pick your language")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t(
                  "onboarding.language.description",
                  "Choose the language you'll dictate in most often. You can change it later."
                )}
              </p>
            </div>

            <div className="space-y-2 p-3 bg-muted/50 border border-border/60 rounded">
              <label className="block text-xs font-medium text-muted-foreground">
                {t("onboarding.transcription.preferredLanguage")}
              </label>
              <LanguageSelector
                value={preferredLanguage}
                onChange={(value) => {
                  updateTranscriptionSettings({ preferredLanguage: value });
                }}
                className="w-full"
              />
            </div>
          </div>
        );

      case 2: { // Permissions
        const platform = permissionsHook.pasteToolsInfo?.platform;
        const isMacOS = platform === "darwin";

        return (
          <div className="space-y-4">
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

            <PermissionsSection permissions={permissionsHook} systemAudio={systemAudio} />
          </div>
        );
      }

      case 3: // Activation
        return renderActivationStep();

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

      {/* Unified control surface */}
      <div className="rounded-lg border border-border-subtle bg-surface-1 overflow-hidden">
        {/* Hotkey section */}
        <div className="p-4 border-b border-border-subtle">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t("onboarding.activation.hotkey")}
            </span>
          </div>
          <HotkeyInput
            value={hotkey}
            onChange={async (newHotkey) => {
              const success = await registerHotkey(newHotkey);
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
            <ActivationModeSelector
              value={activationMode}
              onChange={setActivationMode}
              variant="compact"
            />
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

  const canProceed = () => {
    switch (currentStep) {
      case 0:
        // Corti sign-in is optional — user can skip and configure later in Settings.
        return true;
      case 1:
        // Language is always set (defaults to "auto").
        return true;
      case 2:
        return areRequiredPermissionsMet(permissionsHook.micPermissionGranted);
      case 3:
        return hotkey.trim() !== "";
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

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {/* Title Bar */}
      <div className="shrink-0 z-10">
        <TitleBar
          showTitle={true}
          className="bg-background backdrop-blur-xl border-b border-border shadow-sm"
        ></TitleBar>
      </div>

      {/* Progress Bar */}
      <div className="shrink-0 bg-background/80 backdrop-blur-2xl border-b border-white/5 px-6 md:px-12 py-3 z-10">
        <div className="max-w-3xl mx-auto">
          <StepProgress steps={steps} currentStep={currentStep} />
        </div>
      </div>

      {/* Content - This will grow to fill available space */}
      <div className="flex-1 px-6 md:px-12 overflow-y-auto py-6">
        <div className="w-full max-w-3xl mx-auto">
          <Card className="bg-card/90 backdrop-blur-2xl border border-border/50 dark:border-white/5 shadow-lg rounded-xl overflow-hidden">
            <CardContent className="p-6 md:p-8">{renderStep()}</CardContent>
          </Card>
        </div>
      </div>

      {/* Footer Navigation */}
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
              {currentStep === steps.length - 1 ? (
                <Button
                  onClick={finishOnboarding}
                  disabled={!canProceed()}
                  variant="success"
                  className="h-8 px-6 rounded-full text-xs"
                >
                  <Check className="w-3.5 h-3.5" />
                  {t("common.complete")}
                </Button>
              ) : (
                <Button
                  onClick={nextStep}
                  disabled={!canProceed()}
                  className="h-8 px-6 rounded-full text-xs"
                >
                  {t("common.next")}
                  <ChevronRight className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface CortiEnvOption {
  id: string;
  label: string;
  region: string;
  defaultTenant: string;
  hasClientId: boolean;
}

function CortiLoginStep() {
  const { t } = useTranslation();
  const account = useCortiAccount();

  const [environments, setEnvironments] = useState<CortiEnvOption[]>([]);
  const [environmentId, setEnvironmentId] = useState<string>("eu");
  const [tenant, setTenant] = useState<string>("");
  const [customRegion, setCustomRegion] = useState<string>("");
  const [regionInputValue, setRegionInputValue] = useState<string>("eu");
  const [clientIdOverride, setClientIdOverride] = useState<string>("");
  const [clientSecret, setClientSecret] = useState<string>("");
  const [useClientCreds, setUseClientCreds] = useState(false);

  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState("");

  const refreshEnvironments = useCallback(async () => {
    const envs = await window.electronAPI?.listCortiEnvironments?.();
    if (envs) setEnvironments(envs);
  }, []);

  useEffect(() => {
    (async () => {
      const [envs, envId, ten, customReg, idOverride, secret] = await Promise.all([
        window.electronAPI?.listCortiEnvironments?.(),
        window.electronAPI?.getCortiEnvironment?.(),
        window.electronAPI?.getCortiTenant?.(),
        window.electronAPI?.getCortiCustomRegion?.(),
        window.electronAPI?.getCortiClientIdOverride?.(),
        window.electronAPI?.getCortiClientSecret?.(),
      ]);
      if (envs) setEnvironments(envs);
      if (envId) setEnvironmentId(envId);
      if (ten) setTenant(ten);
      if (customReg) setCustomRegion(customReg);
      if (idOverride) setClientIdOverride(idOverride);
      if (secret) {
        setClientSecret(secret);
        setUseClientCreds(true);
      }
      // Seed the advanced region text from whatever we just loaded.
      const resolved =
        (envId === "custom" ? customReg : envId) || "eu";
      setRegionInputValue(resolved);
    })();
  }, []);

  // Keep the region text in sync when the segmented control switches env.
  useEffect(() => {
    const resolved = environmentId === "custom" ? customRegion : environmentId;
    setRegionInputValue(resolved || "eu");
  }, [environmentId, customRegion]);

  const currentEnvironment = environments.find((env) => env.id === environmentId);
  const clientIdConfigured =
    (currentEnvironment?.hasClientId ?? false) || Boolean(clientIdOverride);

  const persistEnvironment = useCallback(async (nextId: string) => {
    setEnvironmentId(nextId);
    await window.electronAPI?.saveCortiEnvironment?.(nextId);
    useSettingsStore.getState().setCortiEnvironment(nextId);
  }, []);

  const persistTenant = useCallback(async () => {
    await window.electronAPI?.saveCortiTenant?.(tenant);
    useSettingsStore.getState().setCortiTenant(tenant);
  }, [tenant]);

  // Region input accepts any string: matches a known env id (eu, us) → switches
  // to that environment; anything else → switches to "custom" with the typed
  // value used as the subdomain in auth.<region>.corti.app.
  const persistRegionInput = useCallback(async () => {
    const trimmed = regionInputValue.trim().toLowerCase();
    const known = environments.find(
      (env) => env.id !== "custom" && env.id === trimmed
    );
    if (known) {
      setEnvironmentId(known.id);
      await window.electronAPI?.saveCortiEnvironment?.(known.id);
      useSettingsStore.getState().setCortiEnvironment(known.id);
    } else {
      setEnvironmentId("custom");
      setCustomRegion(trimmed);
      await Promise.all([
        window.electronAPI?.saveCortiEnvironment?.("custom"),
        window.electronAPI?.saveCortiCustomRegion?.(trimmed),
      ]);
      useSettingsStore.getState().setCortiEnvironment("custom");
    }
    await refreshEnvironments();
  }, [regionInputValue, environments, refreshEnvironments]);

  const persistClientId = useCallback(async () => {
    await window.electronAPI?.saveCortiClientIdOverride?.(clientIdOverride);
    await refreshEnvironments();
  }, [clientIdOverride, refreshEnvironments]);

  const persistClientSecret = useCallback(async () => {
    const value = useClientCreds ? clientSecret : "";
    await window.electronAPI?.saveCortiClientSecret?.(value);
  }, [clientSecret, useClientCreds]);

  useEffect(() => {
    // When the toggle is switched off, drop the persisted secret so the
    // client_credentials fallback in cortiManager doesn't get triggered.
    if (!useClientCreds) {
      void window.electronAPI?.saveCortiClientSecret?.("");
    }
  }, [useClientCreds]);

  const handleSignIn = async () => {
    setIsConnecting(true);
    setError("");
    // Make sure latest advanced overrides are persisted before opening browser.
    await Promise.all([
      window.electronAPI?.saveCortiClientIdOverride?.(clientIdOverride),
      window.electronAPI?.saveCortiCustomRegion?.(customRegion),
      window.electronAPI?.saveCortiTenant?.(tenant),
    ]);
    const result = await window.electronAPI?.cortiStartPkce?.();
    setIsConnecting(false);
    if (!result?.success) {
      setError(result?.error || t("onboarding.corti.signInFailed", "Sign-in failed"));
      return;
    }
    await account.refresh();
  };

  const handleSignOut = async () => {
    await window.electronAPI?.cortiDisconnect?.();
    await account.refresh();
  };

  // Simple region toggle shows EU/US side-by-side; "Custom" hides in advanced.
  const simpleRegions = environments.filter((env) => env.id !== "custom");

  if (account.isConnected) {
    return (
      <div className="space-y-6">
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-full bg-green-500/10 flex items-center justify-center mx-auto">
            <Check className="w-7 h-7 text-green-500" />
          </div>
          <h2 className="text-xl font-semibold text-foreground tracking-tight">
            {t("onboarding.corti.connectedTitle", "You're connected")}
          </h2>
          <div className="space-y-0.5">
            <p className="text-sm text-foreground">
              {account.name || account.email || t("onboarding.corti.cortiUser", "Corti user")}
            </p>
            {account.name && account.email && account.email !== account.name && (
              <p className="text-xs text-muted-foreground">{account.email}</p>
            )}
          </div>
        </div>

        <div className="flex justify-center">
          <Button variant="ghost" size="sm" onClick={handleSignOut} className="text-xs gap-1.5">
            <LogOut className="w-3.5 h-3.5" />
            {t("onboarding.corti.signOut", "Sign out")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
          <UserCircle className="w-7 h-7 text-primary" />
        </div>
        <h2 className="text-xl font-semibold text-foreground tracking-tight">
          {t("onboarding.corti.title", "Sign in to Corti")}
        </h2>
        <p className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
          {t(
            "onboarding.corti.description",
            "We'll open your browser to finish signing in. You can skip this for now and connect later from Settings."
          )}
        </p>
      </div>

      <div className="space-y-3">
        {/* Segmented region toggle. Custom is reached via advanced. */}
        {simpleRegions.length > 0 && (
          <div className="flex items-center justify-center">
            <div className="inline-flex items-center rounded-full bg-muted p-0.5 border border-border/40">
              {simpleRegions.map((env) => (
                <button
                  key={env.id}
                  type="button"
                  onClick={() => void persistEnvironment(env.id)}
                  className={cn(
                    "px-4 py-1.5 text-xs font-medium rounded-full transition-colors",
                    environmentId === env.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {env.label}
                </button>
              ))}
              {environmentId === "custom" && (
                <span className="px-4 py-1.5 text-xs font-medium rounded-full bg-background text-foreground shadow-sm">
                  {t("onboarding.corti.customRegion", "Custom")}
                </span>
              )}
            </div>
          </div>
        )}

        <Button
          onClick={handleSignIn}
          disabled={isConnecting}
          className="w-full h-10"
        >
          {isConnecting ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <UserCircle className="w-4 h-4 mr-2" />
          )}
          {isConnecting
            ? t("onboarding.corti.opening", "Opening browser…")
            : t("onboarding.corti.signIn", "Sign in to Corti")}
        </Button>

        {!clientIdConfigured && currentEnvironment && (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 p-2.5">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 shrink-0" />
            <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
              {environmentId === "custom"
                ? t(
                    "onboarding.corti.customClientIdMissing",
                    "Open Advanced and enter a client ID to continue."
                  )
                : t(
                    "onboarding.corti.clientIdMissing",
                    "Client ID for {{label}} is not configured. Set {{envVar}} in .env, or override it in Advanced.",
                    {
                      label: currentEnvironment.label,
                      envVar: `CORTI_CLIENT_ID_${currentEnvironment.id.toUpperCase()}`,
                    }
                  )}
            </p>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 border border-destructive/30 p-2.5">
            <AlertTriangle className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />
            <p className="text-[11px] text-destructive leading-relaxed">{error}</p>
          </div>
        )}

        <div className="flex justify-center pt-1">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Sliders className="w-3 h-3" />
                {t("onboarding.corti.advanced", "Advanced options")}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="center"
              sideOffset={8}
              className="w-[340px] p-4 space-y-3"
            >
              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-foreground">
                  {t("onboarding.corti.advanced", "Advanced options")}
                </h4>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {t(
                    "onboarding.corti.advancedHint",
                    "For self-hosted Corti or custom OAuth clients. Most users can leave these alone."
                  )}
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide block">
                  {t("onboarding.corti.region", "Region")}
                </label>
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder="eu"
                  value={regionInputValue}
                  onChange={(e) => setRegionInputValue(e.target.value)}
                  onBlur={() => void persistRegionInput()}
                />
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  {t(
                    "onboarding.corti.regionHint",
                    "Used as the subdomain — auth.<region>.corti.app. Type any value (eu, us, staging…)."
                  )}
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide block">
                  {t("onboarding.corti.tenant", "Tenant / realm")}
                </label>
                <Input
                  className="h-8 text-xs font-mono"
                  placeholder={currentEnvironment?.defaultTenant || "base"}
                  value={tenant}
                  onChange={(e) => setTenant(e.target.value)}
                  onBlur={() => void persistTenant()}
                />
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide block">
                  {t("onboarding.corti.clientIdOverride", "Client ID override")}
                </label>
                <Input
                  className="h-8 text-xs font-mono"
                  type="password"
                  placeholder={t("onboarding.corti.clientIdOverridePlaceholder", "Optional")}
                  value={clientIdOverride}
                  onChange={(e) => setClientIdOverride(e.target.value)}
                  onBlur={() => void persistClientId()}
                />
              </div>

              <div className="space-y-2 pt-1 border-t border-border/40">
                <div className="flex items-center justify-between gap-2 pt-2">
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-foreground">
                      {t("onboarding.corti.useClientCreds", "Use client credentials")}
                    </p>
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      {t(
                        "onboarding.corti.useClientCredsHint",
                        "Skip browser sign-in. Requires a confidential OAuth client."
                      )}
                    </p>
                  </div>
                  <Toggle checked={useClientCreds} onChange={setUseClientCreds} />
                </div>
                {useClientCreds && (
                  <div className="space-y-2">
                    <Input
                      className="h-8 text-xs font-mono"
                      type="password"
                      placeholder={t("onboarding.corti.clientSecret", "Client secret")}
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      onBlur={() => void persistClientSecret()}
                    />
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  );
}
