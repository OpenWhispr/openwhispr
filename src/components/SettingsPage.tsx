import React, { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Badge } from "./ui/badge";
import {
  RefreshCw,
  Download,
  Command,
  Mic,
  Shield,
  FolderOpen,
  LogOut,
  UserCircle,
  Sun,
  Moon,
  Monitor,
  Cloud,
  Key,
  ChevronDown,
  Sparkles,
  AlertTriangle,
  Loader2,
  Check,
  Mail,
} from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { NEON_AUTH_URL, signOut } from "../lib/neonAuth";
import MicPermissionWarning from "./ui/MicPermissionWarning";
import MicrophoneSettings from "./ui/MicrophoneSettings";
import PermissionCard from "./ui/PermissionCard";
import PasteToolsInfo from "./ui/PasteToolsInfo";
import TranscriptionModelPicker from "./TranscriptionModelPicker";
import { ConfirmDialog, AlertDialog } from "./ui/dialog";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { useSettings } from "../hooks/useSettings";
import { useDialogs } from "../hooks/useDialogs";
import { useAgentName } from "../utils/agentName";
import { useWhisper } from "../hooks/useWhisper";
import { usePermissions } from "../hooks/usePermissions";
import { useClipboard } from "../hooks/useClipboard";
import { useUpdater } from "../hooks/useUpdater";

import PromptStudio from "./ui/PromptStudio";
import ReasoningModelSelector from "./ReasoningModelSelector";
import { HotkeyInput } from "./ui/HotkeyInput";
import HotkeyGuidanceAccordion from "./ui/HotkeyGuidanceAccordion";
import { useHotkeyRegistration } from "../hooks/useHotkeyRegistration";
import { getValidationMessage } from "../utils/hotkeyValidator";
import { getPlatform, getCachedPlatform } from "../utils/platform";
import { getDefaultHotkey, formatHotkeyLabel } from "../utils/hotkeys";
import { ActivationModeSelector } from "./ui/ActivationModeSelector";
import { Toggle } from "./ui/toggle";
import DeveloperSection from "./DeveloperSection";
import LanguageSelector from "./ui/LanguageSelector";
import { Skeleton } from "./ui/skeleton";
import { Progress } from "./ui/progress";
import { useToast } from "./ui/Toast";
import { useTheme } from "../hooks/useTheme";
import type { LocalTranscriptionProvider } from "../types/electron";
import logger from "../utils/logger";
import { SettingsRow } from "./ui/SettingsSection";
import { useUsage } from "../hooks/useUsage";
import { cn } from "./lib/utils";

export type SettingsSectionType =
  | "account"
  | "plansBilling"
  | "general"
  | "hotkeys"
  | "transcription"
  | "intelligence"
  | "privacyData"
  | "system";

interface SettingsPageProps {
  activeSection?: SettingsSectionType;
}

const UI_LANGUAGE_OPTIONS: import("./ui/LanguageSelector").LanguageOption[] = [
  { value: "en", label: "English", flag: "🇺🇸" },
  { value: "es", label: "Español", flag: "🇪🇸" },
  { value: "fr", label: "Français", flag: "🇫🇷" },
  { value: "de", label: "Deutsch", flag: "🇩🇪" },
  { value: "pt", label: "Português", flag: "🇵🇹" },
  { value: "it", label: "Italiano", flag: "🇮🇹" },
  { value: "ru", label: "Русский", flag: "🇷🇺" },
  { value: "ja", label: "日本語", flag: "🇯🇵" },
  { value: "zh-CN", label: "简体中文", flag: "🇨🇳" },
  { value: "zh-TW", label: "繁體中文", flag: "🇹🇼" },
];

function SettingsPanel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm divide-y divide-border/30 dark:divide-border-subtle/50 ${className}`}
    >
      {children}
    </div>
  );
}

function SettingsPanelRow({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`px-4 py-3 ${className}`}>{children}</div>;
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
      )}
    </div>
  );
}

interface TranscriptionSectionProps {
  isSignedIn: boolean;
  cloudTranscriptionMode: string;
  setCloudTranscriptionMode: (mode: string) => void;
  useLocalWhisper: boolean;
  setUseLocalWhisper: (value: boolean) => void;
  updateTranscriptionSettings: (settings: { useLocalWhisper: boolean }) => void;
  cloudTranscriptionProvider: string;
  setCloudTranscriptionProvider: (provider: string) => void;
  cloudTranscriptionModel: string;
  setCloudTranscriptionModel: (model: string) => void;
  localTranscriptionProvider: string;
  setLocalTranscriptionProvider: (provider: LocalTranscriptionProvider) => void;
  whisperModel: string;
  setWhisperModel: (model: string) => void;
  parakeetModel: string;
  setParakeetModel: (model: string) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  mistralApiKey: string;
  setMistralApiKey: (key: string) => void;
  customTranscriptionApiKey: string;
  setCustomTranscriptionApiKey: (key: string) => void;
  cloudTranscriptionBaseUrl?: string;
  setCloudTranscriptionBaseUrl: (url: string) => void;
  toast: (opts: {
    title: string;
    description: string;
    variant?: "default" | "destructive" | "success";
    duration?: number;
  }) => void;
}

function TranscriptionSection({
  isSignedIn,
  cloudTranscriptionMode,
  setCloudTranscriptionMode,
  useLocalWhisper,
  setUseLocalWhisper,
  updateTranscriptionSettings,
  cloudTranscriptionProvider,
  setCloudTranscriptionProvider,
  cloudTranscriptionModel,
  setCloudTranscriptionModel,
  localTranscriptionProvider,
  setLocalTranscriptionProvider,
  whisperModel,
  setWhisperModel,
  parakeetModel,
  setParakeetModel,
  openaiApiKey,
  setOpenaiApiKey,
  groqApiKey,
  setGroqApiKey,
  mistralApiKey,
  setMistralApiKey,
  customTranscriptionApiKey,
  setCustomTranscriptionApiKey,
  cloudTranscriptionBaseUrl,
  setCloudTranscriptionBaseUrl,
  toast,
}: TranscriptionSectionProps) {
  const { t } = useTranslation();
  const isCustomMode = cloudTranscriptionMode === "byok" || useLocalWhisper;
  const isCloudMode = isSignedIn && cloudTranscriptionMode === "openwhispr" && !useLocalWhisper;

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("settingsPage.transcription.title")}
        description={t("settingsPage.transcription.description")}
      />

      {/* Mode selector */}
      {isSignedIn && (
        <SettingsPanel>
          <SettingsPanelRow>
            <button
              onClick={() => {
                if (!isCloudMode) {
                  setCloudTranscriptionMode("openwhispr");
                  setUseLocalWhisper(false);
                  updateTranscriptionSettings({ useLocalWhisper: false });
                  toast({
                    title: t("settingsPage.transcription.toasts.switchedCloud.title"),
                    description: t("settingsPage.transcription.toasts.switchedCloud.description"),
                    variant: "success",
                    duration: 3000,
                  });
                }
              }}
              className="w-full flex items-center gap-3 text-left cursor-pointer group"
            >
              <div
                className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                  isCloudMode
                    ? "bg-primary/10 dark:bg-primary/15"
                    : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
                }`}
              >
                <Cloud
                  className={`w-4 h-4 transition-colors ${
                    isCloudMode ? "text-primary" : "text-muted-foreground"
                  }`}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {t("settingsPage.transcription.openwhisprCloud")}
                  </span>
                  {isCloudMode && (
                    <span className="text-xs font-medium text-primary bg-primary/10 dark:bg-primary/15 px-1.5 py-px rounded-sm">
                      {t("common.active")}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground/80 mt-0.5">
                  {t("settingsPage.transcription.openwhisprCloudDescription")}
                </p>
              </div>
              <div
                className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                  isCloudMode
                    ? "border-primary bg-primary"
                    : "border-border-hover dark:border-border-subtle"
                }`}
              >
                {isCloudMode && (
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
                  </div>
                )}
              </div>
            </button>
          </SettingsPanelRow>
          <SettingsPanelRow>
            <button
              onClick={() => {
                if (!isCustomMode) {
                  setCloudTranscriptionMode("byok");
                  setUseLocalWhisper(false);
                  updateTranscriptionSettings({ useLocalWhisper: false });
                  toast({
                    title: t("settingsPage.transcription.toasts.switchedCustom.title"),
                    description: t("settingsPage.transcription.toasts.switchedCustom.description"),
                    variant: "success",
                    duration: 3000,
                  });
                }
              }}
              className="w-full flex items-center gap-3 text-left cursor-pointer group"
            >
              <div
                className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                  isCustomMode
                    ? "bg-accent/10 dark:bg-accent/15"
                    : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
                }`}
              >
                <Key
                  className={`w-4 h-4 transition-colors ${
                    isCustomMode ? "text-accent" : "text-muted-foreground"
                  }`}
                />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">
                    {t("settingsPage.transcription.customSetup")}
                  </span>
                  {isCustomMode && (
                    <span className="text-xs font-medium text-accent bg-accent/10 dark:bg-accent/15 px-1.5 py-px rounded-sm">
                      {t("common.active")}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground/80 mt-0.5">
                  {t("settingsPage.transcription.customSetupDescription")}
                </p>
              </div>
              <div
                className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                  isCustomMode
                    ? "border-accent bg-accent"
                    : "border-border-hover dark:border-border-subtle"
                }`}
              >
                {isCustomMode && (
                  <div className="w-full h-full flex items-center justify-center">
                    <div className="w-1.5 h-1.5 rounded-full bg-accent-foreground" />
                  </div>
                )}
              </div>
            </button>
          </SettingsPanelRow>
        </SettingsPanel>
      )}

      {/* Custom Setup model picker — shown when Custom Setup is active or not signed in */}
      {(isCustomMode || !isSignedIn) && (
        <TranscriptionModelPicker
          selectedCloudProvider={cloudTranscriptionProvider}
          onCloudProviderSelect={setCloudTranscriptionProvider}
          selectedCloudModel={cloudTranscriptionModel}
          onCloudModelSelect={setCloudTranscriptionModel}
          selectedLocalModel={
            localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel
          }
          onLocalModelSelect={(modelId) => {
            if (localTranscriptionProvider === "nvidia") {
              setParakeetModel(modelId);
            } else {
              setWhisperModel(modelId);
            }
          }}
          selectedLocalProvider={localTranscriptionProvider}
          onLocalProviderSelect={setLocalTranscriptionProvider}
          useLocalWhisper={useLocalWhisper}
          onModeChange={(isLocal) => {
            setUseLocalWhisper(isLocal);
            updateTranscriptionSettings({ useLocalWhisper: isLocal });
            if (isLocal) {
              setCloudTranscriptionMode("byok");
            }
          }}
          openaiApiKey={openaiApiKey}
          setOpenaiApiKey={setOpenaiApiKey}
          groqApiKey={groqApiKey}
          setGroqApiKey={setGroqApiKey}
          mistralApiKey={mistralApiKey}
          setMistralApiKey={setMistralApiKey}
          customTranscriptionApiKey={customTranscriptionApiKey}
          setCustomTranscriptionApiKey={setCustomTranscriptionApiKey}
          cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
          setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
          variant="settings"
        />
      )}
    </div>
  );
}

interface AiModelsSectionProps {
  isSignedIn: boolean;
  cloudReasoningMode: string;
  setCloudReasoningMode: (mode: string) => void;
  useReasoningModel: boolean;
  setUseReasoningModel: (value: boolean) => void;
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  reasoningProvider: string;
  setReasoningProvider: (provider: string) => void;
  cloudReasoningBaseUrl: string;
  setCloudReasoningBaseUrl: (url: string) => void;
  openaiApiKey: string;
  setOpenaiApiKey: (key: string) => void;
  anthropicApiKey: string;
  setAnthropicApiKey: (key: string) => void;
  geminiApiKey: string;
  setGeminiApiKey: (key: string) => void;
  groqApiKey: string;
  setGroqApiKey: (key: string) => void;
  customReasoningApiKey: string;
  setCustomReasoningApiKey: (key: string) => void;
  showAlertDialog: (dialog: { title: string; description: string }) => void;
  toast: (opts: {
    title: string;
    description: string;
    variant?: "default" | "destructive" | "success";
    duration?: number;
  }) => void;
}

function AiModelsSection({
  isSignedIn,
  cloudReasoningMode,
  setCloudReasoningMode,
  useReasoningModel,
  setUseReasoningModel,
  reasoningModel,
  setReasoningModel,
  reasoningProvider,
  setReasoningProvider,
  cloudReasoningBaseUrl,
  setCloudReasoningBaseUrl,
  openaiApiKey,
  setOpenaiApiKey,
  anthropicApiKey,
  setAnthropicApiKey,
  geminiApiKey,
  setGeminiApiKey,
  groqApiKey,
  setGroqApiKey,
  customReasoningApiKey,
  setCustomReasoningApiKey,
  showAlertDialog,
  toast,
}: AiModelsSectionProps) {
  const { t } = useTranslation();
  const isCustomMode = cloudReasoningMode === "byok";
  const isCloudMode = isSignedIn && cloudReasoningMode === "openwhispr";

  return (
    <div className="space-y-4">
      <SectionHeader
        title={t("settingsPage.aiModels.title")}
        description={t("settingsPage.aiModels.description")}
      />

      {/* Enable toggle — always at top */}
      <SettingsPanel>
        <SettingsPanelRow>
          <SettingsRow
            label={t("settingsPage.aiModels.enableTextCleanup")}
            description={t("settingsPage.aiModels.enableTextCleanupDescription")}
          >
            <Toggle checked={useReasoningModel} onChange={setUseReasoningModel} />
          </SettingsRow>
        </SettingsPanelRow>
      </SettingsPanel>

      {useReasoningModel && (
        <>
          {/* Mode selector */}
          {isSignedIn && (
            <SettingsPanel>
              <SettingsPanelRow>
                <button
                  onClick={() => {
                    if (!isCloudMode) {
                      setCloudReasoningMode("openwhispr");
                      toast({
                        title: t("settingsPage.aiModels.toasts.switchedCloud.title"),
                        description: t("settingsPage.aiModels.toasts.switchedCloud.description"),
                        variant: "success",
                        duration: 3000,
                      });
                    }
                  }}
                  className="w-full flex items-center gap-3 text-left cursor-pointer group"
                >
                  <div
                    className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                      isCloudMode
                        ? "bg-primary/10 dark:bg-primary/15"
                        : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
                    }`}
                  >
                    <Cloud
                      className={`w-4 h-4 transition-colors ${
                        isCloudMode ? "text-primary" : "text-muted-foreground"
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground">
                        {t("settingsPage.aiModels.openwhisprCloud")}
                      </span>
                      {isCloudMode && (
                        <span className="text-xs font-medium text-primary bg-primary/10 dark:bg-primary/15 px-1.5 py-px rounded-sm">
                          {t("common.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground/80 mt-0.5">
                      {t("settingsPage.aiModels.openwhisprCloudDescription")}
                    </p>
                  </div>
                  <div
                    className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                      isCloudMode
                        ? "border-primary bg-primary"
                        : "border-border-hover dark:border-border-subtle"
                    }`}
                  >
                    {isCloudMode && (
                      <div className="w-full h-full flex items-center justify-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary-foreground" />
                      </div>
                    )}
                  </div>
                </button>
              </SettingsPanelRow>
              <SettingsPanelRow>
                <button
                  onClick={() => {
                    if (!isCustomMode) {
                      setCloudReasoningMode("byok");
                      toast({
                        title: t("settingsPage.aiModels.toasts.switchedCustom.title"),
                        description: t("settingsPage.aiModels.toasts.switchedCustom.description"),
                        variant: "success",
                        duration: 3000,
                      });
                    }
                  }}
                  className="w-full flex items-center gap-3 text-left cursor-pointer group"
                >
                  <div
                    className={`w-8 h-8 rounded-md flex items-center justify-center shrink-0 transition-colors ${
                      isCustomMode
                        ? "bg-accent/10 dark:bg-accent/15"
                        : "bg-muted/60 dark:bg-surface-raised group-hover:bg-muted dark:group-hover:bg-surface-3"
                    }`}
                  >
                    <Key
                      className={`w-4 h-4 transition-colors ${
                        isCustomMode ? "text-accent" : "text-muted-foreground"
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground">
                        {t("settingsPage.aiModels.customSetup")}
                      </span>
                      {isCustomMode && (
                        <span className="text-xs font-medium text-accent bg-accent/10 dark:bg-accent/15 px-1.5 py-px rounded-sm">
                          {t("common.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground/80 mt-0.5">
                      {t("settingsPage.aiModels.customSetupDescription")}
                    </p>
                  </div>
                  <div
                    className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                      isCustomMode
                        ? "border-accent bg-accent"
                        : "border-border-hover dark:border-border-subtle"
                    }`}
                  >
                    {isCustomMode && (
                      <div className="w-full h-full flex items-center justify-center">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-foreground" />
                      </div>
                    )}
                  </div>
                </button>
              </SettingsPanelRow>
            </SettingsPanel>
          )}

          {/* Custom Setup model picker — shown when Custom Setup is active or not signed in */}
          {(isCustomMode || !isSignedIn) && (
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
          )}
        </>
      )}
    </div>
  );
}

export default function SettingsPage({ activeSection = "general" }: SettingsPageProps) {
  const {
    confirmDialog,
    alertDialog,
    showConfirmDialog,
    showAlertDialog,
    hideConfirmDialog,
    hideAlertDialog,
  } = useDialogs();

  const {
    useLocalWhisper,
    whisperModel,
    localTranscriptionProvider,
    parakeetModel,
    uiLanguage,
    preferredLanguage,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    cloudReasoningBaseUrl,
    useReasoningModel,
    reasoningModel,
    reasoningProvider,
    openaiApiKey,
    anthropicApiKey,
    geminiApiKey,
    groqApiKey,
    mistralApiKey,
    dictationKey,
    activationMode,
    setActivationMode,
    preferBuiltInMic,
    selectedMicDeviceId,
    setPreferBuiltInMic,
    setSelectedMicDeviceId,
    setUseLocalWhisper,
    setUiLanguage,
    setWhisperModel,
    setLocalTranscriptionProvider,
    setParakeetModel,
    setCloudTranscriptionProvider,
    setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl,
    setCloudReasoningBaseUrl,
    setUseReasoningModel,
    setReasoningModel,
    setReasoningProvider,
    setOpenaiApiKey,
    setAnthropicApiKey,
    setGeminiApiKey,
    setGroqApiKey,
    setMistralApiKey,
    customTranscriptionApiKey,
    setCustomTranscriptionApiKey,
    customReasoningApiKey,
    setCustomReasoningApiKey,
    setDictationKey,
    updateTranscriptionSettings,
    updateReasoningSettings,
    cloudTranscriptionMode,
    setCloudTranscriptionMode,
    cloudReasoningMode,
    setCloudReasoningMode,
    audioCuesEnabled,
    setAudioCuesEnabled,
    floatingIconAutoHide,
    setFloatingIconAutoHide,
    cloudBackupEnabled,
    setCloudBackupEnabled,
    telemetryEnabled,
    setTelemetryEnabled,
    customDictionary,
    setCustomDictionary,
  } = useSettings();

  const { t, i18n } = useTranslation();
  const { toast } = useToast();

  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [isRemovingModels, setIsRemovingModels] = useState(false);
  const cachePathHint =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)
      ? "%USERPROFILE%\\.cache\\openwhispr"
      : "~/.cache/openwhispr";

  const {
    status: updateStatus,
    info: updateInfo,
    downloadProgress: updateDownloadProgress,
    isChecking: checkingForUpdates,
    isDownloading: downloadingUpdate,
    isInstalling: installInitiated,
    checkForUpdates,
    downloadUpdate,
    installUpdate: installUpdateAction,
    getAppVersion,
    error: updateError,
  } = useUpdater();

  const isUpdateAvailable =
    !updateStatus.isDevelopment && (updateStatus.updateAvailable || updateStatus.updateDownloaded);

  const whisperHook = useWhisper();
  const permissionsHook = usePermissions(showAlertDialog);
  useClipboard(showAlertDialog);
  const { agentName, setAgentName } = useAgentName();
  const [agentNameInput, setAgentNameInput] = useState(agentName);
  const { theme, setTheme } = useTheme();
  const usage = useUsage();
  const hasShownApproachingToast = useRef(false);
  useEffect(() => {
    if (usage?.isApproachingLimit && !hasShownApproachingToast.current) {
      hasShownApproachingToast.current = true;
      toast({
        title: t("settingsPage.account.toasts.approachingLimit.title"),
        description: t("settingsPage.account.toasts.approachingLimit.description", {
          used: usage.wordsUsed.toLocaleString(i18n.language),
          limit: usage.limit.toLocaleString(i18n.language),
        }),
        duration: 6000,
      });
    }
  }, [usage?.isApproachingLimit, usage?.wordsUsed, usage?.limit, toast, t, i18n.language]);

  const installTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { registerHotkey, isRegistering: isHotkeyRegistering } = useHotkeyRegistration({
    onSuccess: (registeredHotkey) => {
      setDictationKey(registeredHotkey);
    },
    showSuccessToast: false,
    showErrorToast: true,
    showAlert: showAlertDialog,
  });

  const validateHotkeyForInput = useCallback(
    (hotkey: string) => getValidationMessage(hotkey, getPlatform()),
    []
  );

  const [isUsingGnomeHotkeys, setIsUsingGnomeHotkeys] = useState(false);

  const platform = getCachedPlatform();

  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(true);

  useEffect(() => {
    if (platform === "linux") {
      setAutoStartLoading(false);
      return;
    }
    const loadAutoStart = async () => {
      if (window.electronAPI?.getAutoStartEnabled) {
        try {
          const enabled = await window.electronAPI.getAutoStartEnabled();
          setAutoStartEnabled(enabled);
        } catch (error) {
          logger.error("Failed to get auto-start status", error, "settings");
        }
      }
      setAutoStartLoading(false);
    };
    loadAutoStart();
  }, [platform]);

  const handleAutoStartChange = async (enabled: boolean) => {
    if (window.electronAPI?.setAutoStartEnabled) {
      try {
        setAutoStartLoading(true);
        const result = await window.electronAPI.setAutoStartEnabled(enabled);
        if (result.success) {
          setAutoStartEnabled(enabled);
        }
      } catch (error) {
        logger.error("Failed to set auto-start", error, "settings");
      } finally {
        setAutoStartLoading(false);
      }
    }
  };

  useEffect(() => {
    let mounted = true;

    const timer = setTimeout(async () => {
      if (!mounted) return;

      const version = await getAppVersion();
      if (version && mounted) setCurrentVersion(version);

      if (mounted) {
        whisperHook.checkWhisperInstallation();
      }
    }, 100);

    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [whisperHook.checkWhisperInstallation, getAppVersion]);

  useEffect(() => {
    const checkHotkeyMode = async () => {
      try {
        const info = await window.electronAPI?.getHotkeyModeInfo();
        if (info?.isUsingGnome) {
          setIsUsingGnomeHotkeys(true);
          setActivationMode("tap");
        }
      } catch (error) {
        logger.error("Failed to check hotkey mode", error, "settings");
      }
    };
    checkHotkeyMode();
  }, [setActivationMode]);

  useEffect(() => {
    if (updateError) {
      showAlertDialog({
        title: t("settingsPage.general.updates.dialogs.updateError.title"),
        description: t("settingsPage.general.updates.dialogs.updateError.description"),
      });
    }
  }, [updateError, showAlertDialog, t]);

  useEffect(() => {
    if (installInitiated) {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
      }
      installTimeoutRef.current = setTimeout(() => {
        showAlertDialog({
          title: t("settingsPage.general.updates.dialogs.almostThere.title"),
          description: t("settingsPage.general.updates.dialogs.almostThere.description"),
        });
      }, 10000);
    } else if (installTimeoutRef.current) {
      clearTimeout(installTimeoutRef.current);
      installTimeoutRef.current = null;
    }

    return () => {
      if (installTimeoutRef.current) {
        clearTimeout(installTimeoutRef.current);
        installTimeoutRef.current = null;
      }
    };
  }, [installInitiated, showAlertDialog, t]);

  const resetAccessibilityPermissions = () => {
    const message = t("settingsPage.permissions.resetAccessibility.description");

    showConfirmDialog({
      title: t("settingsPage.permissions.resetAccessibility.title"),
      description: message,
      onConfirm: () => {
        permissionsHook.openAccessibilitySettings();
      },
    });
  };

  const handleRemoveModels = useCallback(() => {
    if (isRemovingModels) return;

    showConfirmDialog({
      title: t("settingsPage.developer.removeModels.title"),
      description: t("settingsPage.developer.removeModels.description", { path: cachePathHint }),
      confirmText: t("settingsPage.developer.removeModels.confirmText"),
      variant: "destructive",
      onConfirm: async () => {
        setIsRemovingModels(true);
        try {
          const results = await Promise.allSettled([
            window.electronAPI?.deleteAllWhisperModels?.(),
            window.electronAPI?.deleteAllParakeetModels?.(),
            window.electronAPI?.modelDeleteAll?.(),
          ]);

          const anyFailed = results.some(
            (r) =>
              r.status === "rejected" || (r.status === "fulfilled" && r.value && !r.value.success)
          );

          if (anyFailed) {
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.failedTitle"),
              description: t("settingsPage.developer.removeModels.failedDescription"),
            });
          } else {
            window.dispatchEvent(new Event("openwhispr-models-cleared"));
            showAlertDialog({
              title: t("settingsPage.developer.removeModels.successTitle"),
              description: t("settingsPage.developer.removeModels.successDescription"),
            });
          }
        } catch {
          showAlertDialog({
            title: t("settingsPage.developer.removeModels.failedTitle"),
            description: t("settingsPage.developer.removeModels.failedDescriptionShort"),
          });
        } finally {
          setIsRemovingModels(false);
        }
      },
    });
  }, [isRemovingModels, cachePathHint, showConfirmDialog, showAlertDialog, t]);

  const { isSignedIn, isLoaded, user } = useAuth();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isOpeningBilling, setIsOpeningBilling] = useState(false);
  const [billingPeriod, setBillingPeriod] = useState<"monthly" | "annual">("monthly");

  useEffect(() => {
    if (usage?.billingInterval) {
      setBillingPeriod(usage.billingInterval);
    }
  }, [usage?.billingInterval]);

  const startOnboarding = useCallback(() => {
    localStorage.setItem("pendingCloudMigration", "true");
    localStorage.setItem("onboardingCurrentStep", "0");
    localStorage.removeItem("onboardingCompleted");
    window.location.reload();
  }, []);

  const handleSignOut = useCallback(async () => {
    setIsSigningOut(true);
    try {
      await signOut();
      window.location.reload();
    } catch (error) {
      logger.error("Sign out failed", error, "auth");
      showAlertDialog({
        title: t("settingsPage.account.signOut.failedTitle"),
        description: t("settingsPage.account.signOut.failedDescription"),
      });
    } finally {
      setIsSigningOut(false);
    }
  }, [showAlertDialog, t]);

  const renderSectionContent = () => {
    switch (activeSection) {
      case "account":
        return (
          <div className="space-y-5">
            {!NEON_AUTH_URL ? (
              <>
                <SectionHeader
                  title={t("settingsPage.account.title")}
                  description={t("settingsPage.account.notConfigured")}
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.featuresDisabled")}
                      description={t("settingsPage.account.featuresDisabledDescription")}
                    >
                      <Badge variant="warning">{t("settingsPage.account.disabled")}</Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ) : isLoaded && isSignedIn && user ? (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 overflow-hidden bg-primary/10 dark:bg-primary/15">
                        {user.image ? (
                          <img
                            src={user.image}
                            alt={user.name || t("settingsPage.account.user")}
                            className="w-10 h-10 rounded-full object-cover"
                          />
                        ) : (
                          <UserCircle className="w-5 h-5 text-primary" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground truncate">
                          {user.name || t("settingsPage.account.user")}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                      </div>
                      <Badge variant="success">{t("settingsPage.account.signedIn")}</Badge>
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <Button
                      onClick={handleSignOut}
                      variant="outline"
                      disabled={isSigningOut}
                      size="sm"
                      className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive/50"
                    >
                      <LogOut className="mr-1.5 h-3.5 w-3.5" />
                      {isSigningOut
                        ? t("settingsPage.account.signOut.signingOut")
                        : t("settingsPage.account.signOut.signOut")}
                    </Button>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ) : isLoaded ? (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.notSignedIn")}
                      description={t("settingsPage.account.notSignedInDescription")}
                    >
                      <Badge variant="outline">{t("settingsPage.account.offline")}</Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <div className="rounded-lg border border-primary/20 dark:border-primary/15 bg-primary/3 dark:bg-primary/6 p-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-md bg-primary/10 dark:bg-primary/15 flex items-center justify-center shrink-0 mt-0.5">
                      <Sparkles className="w-4 h-4 text-primary" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-2.5">
                      <div>
                        <p className="text-xs font-medium text-foreground">
                          {t("settingsPage.account.trialCta.title")}
                        </p>
                        <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                          {t("settingsPage.account.trialCta.description")}
                        </p>
                      </div>
                      <Button onClick={startOnboarding} size="sm" className="w-full">
                        <UserCircle className="mr-1.5 h-3.5 w-3.5" />
                        {t("settingsPage.account.trialCta.button")}
                      </Button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <SectionHeader title={t("settingsPage.account.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            )}
          </div>
        );

      case "plansBilling":
        return (
          <div className="space-y-5">
            {!NEON_AUTH_URL ? (
              <>
                <SectionHeader
                  title={t("settingsPage.account.pricing.title")}
                  description={t("settingsPage.account.notConfigured")}
                />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.account.featuresDisabled")}
                      description={t("settingsPage.account.featuresDisabledDescription")}
                    >
                      <Badge variant="warning">{t("settingsPage.account.disabled")}</Badge>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            ) : isLoaded ? (
              <>
                <SectionHeader title={t("settingsPage.account.pricing.title")} />
                <div className="space-y-2.5">
                  <div className="flex justify-center">
                    <div className="inline-flex rounded-md bg-muted/40 dark:bg-surface-2/40 p-0.5 border border-border/30 dark:border-border-subtle/40">
                      <button
                        onClick={() => setBillingPeriod("monthly")}
                        className={cn(
                          "px-3 py-1 text-[11px] font-medium rounded-[3px] transition-all duration-150",
                          billingPeriod === "monthly"
                            ? "bg-background dark:bg-surface-raised text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {t("settingsPage.account.pricing.monthly")}
                      </button>
                      <button
                        onClick={() => setBillingPeriod("annual")}
                        className={cn(
                          "px-3 py-1 text-[11px] font-medium rounded-[3px] transition-all duration-150 flex items-center gap-1",
                          billingPeriod === "annual"
                            ? "bg-background dark:bg-surface-raised text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {t("settingsPage.account.pricing.annual")}
                        <span className="text-[9px] font-semibold text-primary">
                          {t("settingsPage.account.pricing.annualBadge")}
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {/* Free */}
                    <div
                      className={cn(
                        "rounded-md border p-2.5 flex flex-col",
                        !usage?.isSubscribed && !usage?.isTrial
                          ? "border-primary/30 bg-primary/3 dark:border-primary/20 dark:bg-primary/5"
                          : "border-border/50 dark:border-border-subtle/60 bg-card/30 dark:bg-surface-2/30"
                      )}
                    >
                      <p className="text-[11px] font-semibold text-foreground">
                        {t("settingsPage.account.pricing.free.name")}
                      </p>
                      <div className="flex items-baseline gap-0.5 mt-0.5">
                        <span className="text-sm font-bold text-foreground">
                          {t("settingsPage.account.pricing.free.price")}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {t("settingsPage.account.pricing.free.period")}
                        </span>
                      </div>
                      <p className="text-[9px] font-medium text-primary/80 mt-1.5">
                        {t("settingsPage.account.pricing.free.trialNote")}
                      </p>
                      <ul className="space-y-0.5 mt-2 flex-1">
                        {(
                          t("settingsPage.account.pricing.free.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                          >
                            <Check size={9} className="mt-[2px] text-primary/70 shrink-0" />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      {isSignedIn && !usage?.isSubscribed && !usage?.isTrial ? (
                        <div className="mt-2 text-center">
                          <span className="text-[9px] font-medium text-primary/70">
                            {t("settingsPage.account.pricing.currentPlan")}
                          </span>
                        </div>
                      ) : !isSignedIn ? (
                        <Button
                          onClick={startOnboarding}
                          variant="outline"
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {t("settingsPage.account.signedOutPlans.button")}
                        </Button>
                      ) : null}
                    </div>

                    {/* Pro */}
                    <div
                      className={cn(
                        "rounded-md border-2 p-2.5 flex flex-col",
                        usage?.isSubscribed || usage?.isTrial
                          ? "border-primary/40 bg-primary/5 dark:border-primary/30 dark:bg-primary/8"
                          : "border-primary/20 bg-primary/2 dark:border-primary/15 dark:bg-primary/3"
                      )}
                    >
                      <p className="text-[11px] font-semibold text-foreground">
                        {t("settingsPage.account.pricing.pro.name")}
                      </p>
                      <div className="flex items-baseline gap-0.5 mt-0.5">
                        <span className="text-sm font-bold text-foreground">
                          {billingPeriod === "monthly"
                            ? t("settingsPage.account.pricing.pro.monthlyPrice")
                            : t("settingsPage.account.pricing.pro.annualPrice")}
                        </span>
                        <span className="text-[9px] text-muted-foreground">
                          {billingPeriod === "monthly"
                            ? t("settingsPage.account.pricing.pro.monthlyPeriod")
                            : t("settingsPage.account.pricing.pro.annualPeriod")}
                        </span>
                        {billingPeriod === "annual" && (
                          <span className="text-[9px] font-semibold text-primary ml-1">
                            {t("settingsPage.account.pricing.annualBadge")}
                          </span>
                        )}
                      </div>
                      <ul className="space-y-0.5 mt-2 flex-1">
                        {(
                          t("settingsPage.account.pricing.pro.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                          >
                            <Check size={9} className="mt-[2px] text-primary shrink-0" />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      {usage?.isSubscribed && !usage?.isTrial ? (
                        billingPeriod === "annual" ? (
                          <Button
                            onClick={async () => {
                              const result = await usage.openBillingPortal();
                              if (!result.success) {
                                toast({
                                  title: t("settingsPage.account.billing.couldNotOpenTitle"),
                                  description: t(
                                    "settingsPage.account.billing.couldNotOpenDescription"
                                  ),
                                  variant: "destructive",
                                });
                              }
                            }}
                            variant="outline"
                            size="sm"
                            className="mt-2 w-full h-6 text-[10px]"
                            disabled={usage?.checkoutLoading}
                          >
                            {t("settingsPage.account.pricing.pro.switchToAnnual")}
                          </Button>
                        ) : (
                          <div className="mt-2 text-center">
                            <span className="text-[9px] font-medium text-primary">
                              {t("settingsPage.account.pricing.currentPlan")}
                            </span>
                          </div>
                        )
                      ) : usage?.isTrial ? (
                        <div className="mt-2 text-center">
                          <span className="text-[9px] font-medium text-primary">
                            {t("settingsPage.account.pricing.currentPlan")}
                          </span>
                        </div>
                      ) : (
                        <Button
                          onClick={() =>
                            window.electronAPI?.openExternal?.(
                              `https://openwhispr.com/get-started?plan=${billingPeriod}`
                            )
                          }
                          size="sm"
                          className="mt-2 w-full h-6 text-[10px]"
                        >
                          {t("settingsPage.account.pricing.pro.cta")}
                        </Button>
                      )}
                    </div>

                    {/* Enterprise */}
                    <div className="rounded-md border border-border/50 dark:border-border-subtle/60 bg-card/30 dark:bg-surface-2/30 p-2.5 flex flex-col">
                      <p className="text-[11px] font-semibold text-foreground">
                        {t("settingsPage.account.pricing.enterprise.name")}
                      </p>
                      <div className="flex items-baseline gap-0.5 mt-0.5">
                        <span className="text-sm font-bold text-foreground">
                          {t("settingsPage.account.pricing.enterprise.price")}
                        </span>
                      </div>
                      <ul className="space-y-0.5 mt-2 flex-1">
                        {(
                          t("settingsPage.account.pricing.enterprise.features", {
                            returnObjects: true,
                          }) as string[]
                        ).map((feature, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-1 text-[10px] text-muted-foreground leading-tight"
                          >
                            <Check
                              size={9}
                              className="mt-[2px] text-purple-500 dark:text-purple-400 shrink-0"
                            />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2 w-full h-6 text-[10px]"
                        onClick={() =>
                          window.electronAPI?.openExternal?.("mailto:gabe@openwhispr.com")
                        }
                      >
                        <Mail size={10} />
                        {t("settingsPage.account.pricing.enterprise.cta")}
                      </Button>
                    </div>
                  </div>
                </div>

                {isSignedIn ? (
                  <>
                    <SectionHeader title={t("settingsPage.account.planTitle")} />
                    {!usage || !usage.hasLoaded ? (
                      <SettingsPanel>
                        <SettingsPanelRow>
                          <div className="flex items-center justify-between">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-5 w-16 rounded-full" />
                          </div>
                        </SettingsPanelRow>
                        <SettingsPanelRow>
                          <div className="space-y-2">
                            <Skeleton className="h-3 w-48" />
                            <Skeleton className="h-8 w-full rounded" />
                          </div>
                        </SettingsPanelRow>
                      </SettingsPanel>
                    ) : (
                      <SettingsPanel>
                        {usage.isPastDue && (
                          <SettingsPanelRow>
                            <Alert
                              variant="warning"
                              className="dark:bg-amber-950/50 dark:border-amber-800 dark:text-amber-200 dark:[&>svg]:text-amber-400"
                            >
                              <AlertTriangle className="h-4 w-4" />
                              <AlertTitle>{t("settingsPage.account.pastDue.title")}</AlertTitle>
                              <AlertDescription>
                                {t("settingsPage.account.pastDue.description")}
                              </AlertDescription>
                            </Alert>
                          </SettingsPanelRow>
                        )}

                        <SettingsPanelRow>
                          <SettingsRow
                            label={
                              usage.isTrial
                                ? t("settingsPage.account.planLabels.trial")
                                : usage.isPastDue
                                  ? t("settingsPage.account.planLabels.free")
                                  : usage.isSubscribed
                                    ? t("settingsPage.account.planLabels.pro")
                                    : t("settingsPage.account.planLabels.free")
                            }
                            description={
                              usage.isTrial
                                ? t("settingsPage.account.planDescriptions.trial", {
                                    days: usage.trialDaysLeft,
                                  })
                                : usage.isPastDue
                                  ? t("settingsPage.account.planDescriptions.pastDue", {
                                      used: usage.wordsUsed.toLocaleString(i18n.language),
                                      limit: usage.limit.toLocaleString(i18n.language),
                                    })
                                  : usage.isSubscribed
                                    ? usage.currentPeriodEnd
                                      ? t("settingsPage.account.planDescriptions.nextBilling", {
                                          date: new Date(usage.currentPeriodEnd).toLocaleDateString(
                                            i18n.language,
                                            { month: "short", day: "numeric", year: "numeric" }
                                          ),
                                        })
                                      : t("settingsPage.account.planDescriptions.unlimited")
                                    : t("settingsPage.account.planDescriptions.freeUsage", {
                                        used: usage.wordsUsed.toLocaleString(i18n.language),
                                        limit: usage.limit.toLocaleString(i18n.language),
                                      })
                            }
                          >
                            {usage.isTrial ? (
                              <Badge variant="info">{t("settingsPage.account.badges.trial")}</Badge>
                            ) : usage.isPastDue ? (
                              <Badge variant="destructive">
                                {t("settingsPage.account.badges.pastDue")}
                              </Badge>
                            ) : usage.isSubscribed ? (
                              <Badge variant="success">
                                {t("settingsPage.account.badges.pro")}
                              </Badge>
                            ) : usage.isOverLimit ? (
                              <Badge variant="warning">
                                {t("settingsPage.account.badges.limitReached")}
                              </Badge>
                            ) : (
                              <Badge variant="outline">
                                {t("settingsPage.account.badges.free")}
                              </Badge>
                            )}
                          </SettingsRow>
                        </SettingsPanelRow>

                        {!usage.isSubscribed && !usage.isTrial && (
                          <SettingsPanelRow>
                            <div className="space-y-1.5">
                              <Progress
                                value={
                                  usage.limit > 0
                                    ? Math.min(100, (usage.wordsUsed / usage.limit) * 100)
                                    : 0
                                }
                                className={cn(
                                  "h-1.5",
                                  usage.isOverLimit
                                    ? "[&>div]:bg-destructive"
                                    : usage.isApproachingLimit
                                      ? "[&>div]:bg-warning"
                                      : "[&>div]:bg-primary"
                                )}
                              />
                              <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span className="tabular-nums">
                                  {usage.wordsUsed.toLocaleString(i18n.language)} /{" "}
                                  {usage.limit.toLocaleString(i18n.language)}
                                </span>
                                {usage.isApproachingLimit && (
                                  <span className="text-warning">
                                    {t("settingsPage.account.wordsRemaining", {
                                      remaining: usage.wordsRemaining.toLocaleString(i18n.language),
                                    })}
                                  </span>
                                )}
                                {!usage.isApproachingLimit && !usage.isOverLimit && (
                                  <span>{t("settingsPage.account.rollingWeeklyLimit")}</span>
                                )}
                              </div>
                            </div>
                          </SettingsPanelRow>
                        )}

                        <SettingsPanelRow>
                          {usage.isPastDue ? (
                            <Button
                              onClick={async () => {
                                setIsOpeningBilling(true);
                                try {
                                  const result = await usage.openBillingPortal();
                                  if (!result.success) {
                                    toast({
                                      title: t("settingsPage.account.billing.couldNotOpenTitle"),
                                      description: t(
                                        "settingsPage.account.billing.couldNotOpenDescription"
                                      ),
                                      variant: "destructive",
                                    });
                                  }
                                } finally {
                                  setIsOpeningBilling(false);
                                }
                              }}
                              disabled={isOpeningBilling}
                              size="sm"
                              className="w-full"
                            >
                              {isOpeningBilling ? (
                                <>
                                  <Loader2 size={14} className="animate-spin" />
                                  {t("settingsPage.account.billing.opening")}
                                </>
                              ) : (
                                t("settingsPage.account.billing.updatePaymentMethod")
                              )}
                            </Button>
                          ) : usage.isSubscribed && !usage.isTrial ? (
                            <Button
                              onClick={async () => {
                                const result = await usage.openBillingPortal();
                                if (!result.success) {
                                  toast({
                                    title: t("settingsPage.account.billing.couldNotOpenTitle"),
                                    description: t(
                                      "settingsPage.account.billing.couldNotOpenDescription"
                                    ),
                                    variant: "destructive",
                                  });
                                }
                              }}
                              variant="outline"
                              size="sm"
                              className="w-full"
                              disabled={usage.checkoutLoading}
                            >
                              {usage.checkoutLoading
                                ? t("settingsPage.account.billing.opening")
                                : t("settingsPage.account.billing.manageBilling")}
                            </Button>
                          ) : (
                            <Button
                              onClick={async () => {
                                const result = await usage.openCheckout(billingPeriod);
                                if (!result.success) {
                                  toast({
                                    title: t("settingsPage.account.checkout.couldNotOpenTitle"),
                                    description: t(
                                      "settingsPage.account.checkout.couldNotOpenDescription"
                                    ),
                                    variant: "destructive",
                                  });
                                }
                              }}
                              size="sm"
                              className="w-full"
                              disabled={usage.checkoutLoading}
                            >
                              {usage.checkoutLoading
                                ? t("settingsPage.account.checkout.opening")
                                : t("settingsPage.account.checkout.upgradeToPro")}
                            </Button>
                          )}
                        </SettingsPanelRow>
                      </SettingsPanel>
                    )}
                  </>
                ) : null}
              </>
            ) : (
              <>
                <SectionHeader title={t("settingsPage.account.pricing.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>
              </>
            )}
          </div>
        );

      case "general":
        return (
          <div className="space-y-6">
            {/* Appearance */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.appearance.title")}
                description={t("settingsPage.general.appearance.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.appearance.theme")}
                    description={t("settingsPage.general.appearance.themeDescription")}
                  >
                    <div className="inline-flex items-center gap-px p-0.5 bg-muted/60 dark:bg-surface-2 rounded-md">
                      {(
                        [
                          {
                            value: "light",
                            icon: Sun,
                            label: t("settingsPage.general.appearance.light"),
                          },
                          {
                            value: "dark",
                            icon: Moon,
                            label: t("settingsPage.general.appearance.dark"),
                          },
                          {
                            value: "auto",
                            icon: Monitor,
                            label: t("settingsPage.general.appearance.auto"),
                          },
                        ] as const
                      ).map((option) => {
                        const Icon = option.icon;
                        const isSelected = theme === option.value;
                        return (
                          <button
                            key={option.value}
                            onClick={() => setTheme(option.value)}
                            className={`
                              flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-xs font-medium
                              transition-colors duration-100
                              ${
                                isSelected
                                  ? "bg-background dark:bg-surface-raised text-foreground shadow-sm"
                                  : "text-muted-foreground hover:text-foreground"
                              }
                            `}
                          >
                            <Icon className={`w-3 h-3 ${isSelected ? "text-primary" : ""}`} />
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Sound Effects */}
            <div>
              <SectionHeader title={t("settingsPage.general.soundEffects.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.soundEffects.dictationSounds")}
                    description={t("settingsPage.general.soundEffects.dictationSoundsDescription")}
                  >
                    <Toggle checked={audioCuesEnabled} onChange={setAudioCuesEnabled} />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Floating Icon */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.floatingIcon.title")}
                description={t("settingsPage.general.floatingIcon.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.floatingIcon.autoHide")}
                    description={t("settingsPage.general.floatingIcon.autoHideDescription")}
                  >
                    <Toggle checked={floatingIconAutoHide} onChange={setFloatingIconAutoHide} />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Language */}
            <div>
              <SectionHeader
                title={t("settings.language.sectionTitle")}
                description={t("settings.language.sectionDescription")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.language.uiLabel")}
                    description={t("settings.language.uiDescription")}
                  >
                    <LanguageSelector
                      value={uiLanguage}
                      onChange={setUiLanguage}
                      options={UI_LANGUAGE_OPTIONS}
                      className="min-w-32"
                    />
                  </SettingsRow>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settings.language.transcriptionLabel")}
                    description={t("settings.language.transcriptionDescription")}
                  >
                    <LanguageSelector
                      value={preferredLanguage}
                      onChange={(value) =>
                        updateTranscriptionSettings({ preferredLanguage: value })
                      }
                    />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Startup */}
            {platform !== "linux" && (
              <div>
                <SectionHeader title={t("settingsPage.general.startup.title")} />
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.general.startup.launchAtLogin")}
                      description={t("settingsPage.general.startup.launchAtLoginDescription")}
                    >
                      <Toggle
                        checked={autoStartEnabled}
                        onChange={(checked: boolean) => handleAutoStartChange(checked)}
                        disabled={autoStartLoading}
                      />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            )}

            {/* Microphone */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.microphone.title")}
                description={t("settingsPage.general.microphone.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <MicrophoneSettings
                    preferBuiltInMic={preferBuiltInMic}
                    selectedMicDeviceId={selectedMicDeviceId}
                    onPreferBuiltInChange={setPreferBuiltInMic}
                    onDeviceSelect={setSelectedMicDeviceId}
                  />
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );

      case "hotkeys":
        return (
          <div className="space-y-6">
            {/* Dictation Hotkey */}
            <div>
              <SectionHeader
                title={t("settingsPage.general.hotkey.title")}
                description={t("settingsPage.general.hotkey.description")}
              />
              <SettingsPanel>
                <SettingsPanelRow>
                  <HotkeyInput
                    value={dictationKey}
                    onChange={async (newHotkey) => {
                      await registerHotkey(newHotkey);
                    }}
                    disabled={isHotkeyRegistering}
                    validate={validateHotkeyForInput}
                  />
                  {dictationKey && dictationKey !== getDefaultHotkey() && (
                    <button
                      onClick={() => registerHotkey(getDefaultHotkey())}
                      disabled={isHotkeyRegistering}
                      className="mt-2 text-xs text-muted-foreground/70 hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      {t("settingsPage.general.hotkey.resetToDefault", {
                        hotkey: formatHotkeyLabel(getDefaultHotkey()),
                      })}
                    </button>
                  )}
                </SettingsPanelRow>

                {!isUsingGnomeHotkeys && (
                  <SettingsPanelRow>
                    <p className="text-xs font-medium text-muted-foreground/80 mb-2">
                      {t("settingsPage.general.hotkey.activationMode")}
                    </p>
                    <ActivationModeSelector value={activationMode} onChange={setActivationMode} />
                  </SettingsPanelRow>
                )}
              </SettingsPanel>
            </div>
          </div>
        );

      case "transcription":
        return (
          <TranscriptionSection
            isSignedIn={isSignedIn ?? false}
            cloudTranscriptionMode={cloudTranscriptionMode}
            setCloudTranscriptionMode={setCloudTranscriptionMode}
            useLocalWhisper={useLocalWhisper}
            setUseLocalWhisper={setUseLocalWhisper}
            updateTranscriptionSettings={updateTranscriptionSettings}
            cloudTranscriptionProvider={cloudTranscriptionProvider}
            setCloudTranscriptionProvider={setCloudTranscriptionProvider}
            cloudTranscriptionModel={cloudTranscriptionModel}
            setCloudTranscriptionModel={setCloudTranscriptionModel}
            localTranscriptionProvider={localTranscriptionProvider}
            setLocalTranscriptionProvider={setLocalTranscriptionProvider}
            whisperModel={whisperModel}
            setWhisperModel={setWhisperModel}
            parakeetModel={parakeetModel}
            setParakeetModel={setParakeetModel}
            openaiApiKey={openaiApiKey}
            setOpenaiApiKey={setOpenaiApiKey}
            groqApiKey={groqApiKey}
            setGroqApiKey={setGroqApiKey}
            mistralApiKey={mistralApiKey}
            setMistralApiKey={setMistralApiKey}
            customTranscriptionApiKey={customTranscriptionApiKey}
            setCustomTranscriptionApiKey={setCustomTranscriptionApiKey}
            cloudTranscriptionBaseUrl={cloudTranscriptionBaseUrl}
            setCloudTranscriptionBaseUrl={setCloudTranscriptionBaseUrl}
            toast={toast}
          />
        );

      case "intelligence":
        return (
          <div className="space-y-6">
            {/* Text Cleanup (AI Models) */}
            <AiModelsSection
              isSignedIn={isSignedIn ?? false}
              cloudReasoningMode={cloudReasoningMode}
              setCloudReasoningMode={setCloudReasoningMode}
              useReasoningModel={useReasoningModel}
              setUseReasoningModel={(value) => {
                updateReasoningSettings({ useReasoningModel: value });
              }}
              reasoningModel={reasoningModel}
              setReasoningModel={setReasoningModel}
              reasoningProvider={reasoningProvider}
              setReasoningProvider={setReasoningProvider}
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
              showAlertDialog={showAlertDialog}
              toast={toast}
            />

            {/* Agent Config */}
            <div className="border-t border-border/40 pt-6">
              <SectionHeader
                title={t("settingsPage.agentConfig.title")}
                description={t("settingsPage.agentConfig.description")}
              />

              <div className="space-y-5">
                <div>
                  <p className="text-xs font-medium text-foreground mb-3">
                    {t("settingsPage.agentConfig.agentName")}
                  </p>
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <div className="space-y-3">
                        <div className="flex gap-2">
                          <Input
                            placeholder={t("settingsPage.agentConfig.placeholder")}
                            value={agentNameInput}
                            onChange={(e) => setAgentNameInput(e.target.value)}
                            className="flex-1 text-center text-base font-mono"
                          />
                          <Button
                            onClick={() => {
                              const trimmed = agentNameInput.trim();
                              const oldName = agentName;
                              setAgentName(trimmed);
                              setAgentNameInput(trimmed);
                              let dict = customDictionary.filter((w) => w !== oldName);
                              if (trimmed && !dict.includes(trimmed)) dict = [trimmed, ...dict];
                              setCustomDictionary(dict);
                              showAlertDialog({
                                title: t("settingsPage.agentConfig.dialogs.updatedTitle"),
                                description: t(
                                  "settingsPage.agentConfig.dialogs.updatedDescription",
                                  {
                                    name: trimmed,
                                  }
                                ),
                              });
                            }}
                            disabled={!agentNameInput.trim()}
                            size="sm"
                          >
                            {t("settingsPage.agentConfig.save")}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground/60">
                          {t("settingsPage.agentConfig.helper")}
                        </p>
                      </div>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>

                <div>
                  <SectionHeader title={t("settingsPage.agentConfig.howItWorksTitle")} />
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        {t("settingsPage.agentConfig.howItWorksDescription", { agentName })}
                      </p>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>

                <div>
                  <SectionHeader title={t("settingsPage.agentConfig.examplesTitle")} />
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <div className="space-y-2.5">
                        {[
                          {
                            input: t("settingsPage.agentConfig.examples.formalEmail", {
                              agentName,
                            }),
                            mode: t("settingsPage.agentConfig.instructionMode"),
                          },
                          {
                            input: t("settingsPage.agentConfig.examples.professional", {
                              agentName,
                            }),
                            mode: t("settingsPage.agentConfig.instructionMode"),
                          },
                          {
                            input: t("settingsPage.agentConfig.examples.bulletPoints", {
                              agentName,
                            }),
                            mode: t("settingsPage.agentConfig.instructionMode"),
                          },
                          {
                            input: t("settingsPage.agentConfig.cleanupExample"),
                            mode: t("settingsPage.agentConfig.cleanupMode"),
                          },
                        ].map((example, i) => (
                          <div key={i} className="flex items-start gap-3">
                            <span
                              className={`shrink-0 mt-0.5 text-xs font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                                example.mode === t("settingsPage.agentConfig.instructionMode")
                                  ? "bg-primary/10 text-primary dark:bg-primary/15"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {example.mode}
                            </span>
                            <p className="text-xs text-muted-foreground leading-relaxed">
                              "{example.input}"
                            </p>
                          </div>
                        ))}
                      </div>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>
              </div>
            </div>

            {/* System Prompt */}
            <div className="border-t border-border/40 pt-6">
              <SectionHeader
                title={t("settingsPage.prompts.title")}
                description={t("settingsPage.prompts.description")}
              />
              <PromptStudio />
            </div>
          </div>
        );

      case "privacyData":
        return (
          <div className="space-y-6">
            {/* Privacy */}
            <div>
              <SectionHeader
                title={t("settingsPage.privacy.title")}
                description={t("settingsPage.privacy.description")}
              />

              {isSignedIn && (
                <SettingsPanel className="mb-4">
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.privacy.cloudBackup")}
                      description={t("settingsPage.privacy.cloudBackupDescription")}
                    >
                      <Toggle checked={cloudBackupEnabled} onChange={setCloudBackupEnabled} />
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              )}

              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.privacy.usageAnalytics")}
                    description={t("settingsPage.privacy.usageAnalyticsDescription")}
                  >
                    <Toggle checked={telemetryEnabled} onChange={setTelemetryEnabled} />
                  </SettingsRow>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Permissions */}
            <div className="border-t border-border/40 pt-6">
              <SectionHeader
                title={t("settingsPage.permissions.title")}
                description={t("settingsPage.permissions.description")}
              />

              <div className="space-y-3">
                <PermissionCard
                  icon={Mic}
                  title={t("settingsPage.permissions.microphoneTitle")}
                  description={t("settingsPage.permissions.microphoneDescription")}
                  granted={permissionsHook.micPermissionGranted}
                  onRequest={permissionsHook.requestMicPermission}
                  buttonText={t("settingsPage.permissions.test")}
                  onOpenSettings={permissionsHook.openMicPrivacySettings}
                />

                {platform === "darwin" && (
                  <PermissionCard
                    icon={Shield}
                    title={t("settingsPage.permissions.accessibilityTitle")}
                    description={t("settingsPage.permissions.accessibilityDescription")}
                    granted={permissionsHook.accessibilityPermissionGranted}
                    onRequest={permissionsHook.testAccessibilityPermission}
                    buttonText={t("settingsPage.permissions.testAndGrant")}
                    onOpenSettings={permissionsHook.openAccessibilitySettings}
                  />
                )}
              </div>

              {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
                <MicPermissionWarning
                  error={permissionsHook.micPermissionError}
                  onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                  onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
                />
              )}

              {platform === "linux" &&
                permissionsHook.pasteToolsInfo &&
                !permissionsHook.pasteToolsInfo.available && (
                  <PasteToolsInfo
                    pasteToolsInfo={permissionsHook.pasteToolsInfo}
                    isChecking={permissionsHook.isCheckingPasteTools}
                    onCheck={permissionsHook.checkPasteToolsAvailability}
                  />
                )}

              {platform === "darwin" && (
                <div className="mt-5">
                  <p className="text-xs font-medium text-foreground mb-3">
                    {t("settingsPage.permissions.troubleshootingTitle")}
                  </p>
                  <SettingsPanel>
                    <SettingsPanelRow>
                      <SettingsRow
                        label={t("settingsPage.permissions.resetAccessibility.label")}
                        description={t(
                          "settingsPage.permissions.resetAccessibility.rowDescription"
                        )}
                      >
                        <Button
                          onClick={resetAccessibilityPermissions}
                          variant="ghost"
                          size="sm"
                          className="text-foreground/70 hover:text-foreground"
                        >
                          {t("settingsPage.permissions.troubleshoot")}
                        </Button>
                      </SettingsRow>
                    </SettingsPanelRow>
                  </SettingsPanel>
                </div>
              )}
            </div>
          </div>
        );

      case "system":
        return (
          <div className="space-y-6">
            {/* Software Updates */}
            <div>
              <SectionHeader title={t("settingsPage.general.updates.title")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <SettingsRow
                    label={t("settingsPage.general.updates.currentVersion")}
                    description={
                      updateStatus.isDevelopment
                        ? t("settingsPage.general.updates.devMode")
                        : isUpdateAvailable
                          ? t("settingsPage.general.updates.newVersionAvailable")
                          : t("settingsPage.general.updates.latestVersion")
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs tabular-nums text-muted-foreground font-mono">
                        {currentVersion || t("settingsPage.general.updates.versionPlaceholder")}
                      </span>
                      {updateStatus.isDevelopment ? (
                        <Badge variant="warning">
                          {t("settingsPage.general.updates.badges.dev")}
                        </Badge>
                      ) : isUpdateAvailable ? (
                        <Badge variant="success">
                          {t("settingsPage.general.updates.badges.update")}
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          {t("settingsPage.general.updates.badges.latest")}
                        </Badge>
                      )}
                    </div>
                  </SettingsRow>
                </SettingsPanelRow>

                <SettingsPanelRow>
                  <div className="space-y-2.5">
                    <Button
                      onClick={async () => {
                        try {
                          const result = await checkForUpdates();
                          if (result?.updateAvailable) {
                            showAlertDialog({
                              title: t(
                                "settingsPage.general.updates.dialogs.updateAvailable.title"
                              ),
                              description: t(
                                "settingsPage.general.updates.dialogs.updateAvailable.description",
                                {
                                  version:
                                    result.version || t("settingsPage.general.updates.newVersion"),
                                }
                              ),
                            });
                          } else {
                            showAlertDialog({
                              title: t("settingsPage.general.updates.dialogs.noUpdates.title"),
                              description:
                                result?.message ||
                                t("settingsPage.general.updates.dialogs.noUpdates.description"),
                            });
                          }
                        } catch {
                          showAlertDialog({
                            title: t("settingsPage.general.updates.dialogs.checkFailed.title"),
                            description: t(
                              "settingsPage.general.updates.dialogs.checkFailed.description"
                            ),
                          });
                        }
                      }}
                      disabled={checkingForUpdates || updateStatus.isDevelopment}
                      variant="outline"
                      className="w-full"
                      size="sm"
                    >
                      <RefreshCw
                        size={13}
                        className={`mr-1.5 ${checkingForUpdates ? "animate-spin" : ""}`}
                      />
                      {checkingForUpdates
                        ? t("settingsPage.general.updates.checking")
                        : t("settingsPage.general.updates.checkForUpdates")}
                    </Button>

                    {isUpdateAvailable && !updateStatus.updateDownloaded && (
                      <div className="space-y-2">
                        <Button
                          onClick={async () => {
                            try {
                              await downloadUpdate();
                            } catch {
                              showAlertDialog({
                                title: t(
                                  "settingsPage.general.updates.dialogs.downloadFailed.title"
                                ),
                                description: t(
                                  "settingsPage.general.updates.dialogs.downloadFailed.description"
                                ),
                              });
                            }
                          }}
                          disabled={downloadingUpdate}
                          variant="success"
                          className="w-full"
                          size="sm"
                        >
                          <Download
                            size={13}
                            className={`mr-1.5 ${downloadingUpdate ? "animate-pulse" : ""}`}
                          />
                          {downloadingUpdate
                            ? t("settingsPage.general.updates.downloading", {
                                progress: Math.round(updateDownloadProgress),
                              })
                            : t("settingsPage.general.updates.downloadUpdate", {
                                version: updateInfo?.version || "",
                              })}
                        </Button>

                        {downloadingUpdate && (
                          <div className="h-1 w-full overflow-hidden rounded-full bg-muted/50">
                            <div
                              className="h-full bg-success transition-[width] duration-200 rounded-full"
                              style={{
                                width: `${Math.min(100, Math.max(0, updateDownloadProgress))}%`,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {updateStatus.updateDownloaded && (
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.general.updates.dialogs.installUpdate.title"),
                            description: t(
                              "settingsPage.general.updates.dialogs.installUpdate.description",
                              { version: updateInfo?.version || "" }
                            ),
                            confirmText: t(
                              "settingsPage.general.updates.dialogs.installUpdate.confirmText"
                            ),
                            onConfirm: async () => {
                              try {
                                await installUpdateAction();
                              } catch {
                                showAlertDialog({
                                  title: t(
                                    "settingsPage.general.updates.dialogs.installFailed.title"
                                  ),
                                  description: t(
                                    "settingsPage.general.updates.dialogs.installFailed.description"
                                  ),
                                });
                              }
                            },
                          });
                        }}
                        disabled={installInitiated}
                        className="w-full"
                        size="sm"
                      >
                        <RefreshCw
                          size={14}
                          className={`mr-2 ${installInitiated ? "animate-spin" : ""}`}
                        />
                        {installInitiated
                          ? t("settingsPage.general.updates.restarting")
                          : t("settingsPage.general.updates.installAndRestart")}
                      </Button>
                    )}
                  </div>

                  {updateInfo?.releaseNotes && (
                    <div className="mt-4 pt-4 border-t border-border/30">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        {t("settingsPage.general.updates.whatsNew", {
                          version: updateInfo.version,
                        })}
                      </p>
                      <div
                        className="text-xs text-muted-foreground [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:space-y-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:space-y-1 [&_li]:pl-1 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_a]:text-link [&_a]:underline"
                        dangerouslySetInnerHTML={{ __html: updateInfo.releaseNotes }}
                      />
                    </div>
                  )}
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Developer Tools */}
            <div className="border-t border-border/40 pt-6">
              <DeveloperSection />
            </div>

            {/* Data Management */}
            <div className="border-t border-border/40 pt-6">
              <SectionHeader
                title={t("settingsPage.developer.dataManagementTitle")}
                description={t("settingsPage.developer.dataManagementDescription")}
              />

              <div className="space-y-4">
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.modelCache")}
                      description={cachePathHint}
                    >
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => window.electronAPI?.openWhisperModelsFolder?.()}
                        >
                          <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                          {t("settingsPage.developer.open")}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={handleRemoveModels}
                          disabled={isRemovingModels}
                        >
                          {isRemovingModels
                            ? t("settingsPage.developer.removing")
                            : t("settingsPage.developer.clearCache")}
                        </Button>
                      </div>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>

                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.developer.resetAppData")}
                      description={t("settingsPage.developer.resetAppDataDescription")}
                    >
                      <Button
                        onClick={() => {
                          showConfirmDialog({
                            title: t("settingsPage.developer.resetAll.title"),
                            description: t("settingsPage.developer.resetAll.description"),
                            onConfirm: () => {
                              window.electronAPI
                                ?.cleanupApp()
                                .then(() => {
                                  showAlertDialog({
                                    title: t("settingsPage.developer.resetAll.successTitle"),
                                    description: t(
                                      "settingsPage.developer.resetAll.successDescription"
                                    ),
                                  });
                                  setTimeout(() => {
                                    window.location.reload();
                                  }, 1000);
                                })
                                .catch(() => {
                                  showAlertDialog({
                                    title: t("settingsPage.developer.resetAll.failedTitle"),
                                    description: t(
                                      "settingsPage.developer.resetAll.failedDescription"
                                    ),
                                  });
                                });
                            },
                            variant: "destructive",
                            confirmText: t("settingsPage.developer.resetAll.confirmText"),
                          });
                        }}
                        variant="outline"
                        size="sm"
                        className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:border-destructive"
                      >
                        {t("common.reset")}
                      </Button>
                    </SettingsRow>
                  </SettingsPanelRow>
                </SettingsPanel>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
      />

      <AlertDialog
        open={alertDialog.open}
        onOpenChange={(open) => !open && hideAlertDialog()}
        title={alertDialog.title}
        description={alertDialog.description}
        onOk={() => {}}
      />

      {renderSectionContent()}
    </>
  );
}
