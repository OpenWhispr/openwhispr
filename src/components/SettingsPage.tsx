import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
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
  Sparkles,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { useAuth } from "../hooks/useAuth";
import { NEON_AUTH_URL, signOut } from "../lib/neonAuth";
import MarkdownRenderer from "./ui/MarkdownRenderer";
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
import { getPlatform } from "../utils/platform";
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
  | "general"
  | "transcription"
  | "dictionary"
  | "aiModels"
  | "agentConfig"
  | "prompts"
  | "wakeWord"
  | "permissions"
  | "privacy"
  | "developer";

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

const WAKE_WORD_LOG_MAX = 20;

interface WakeWordHeardEntry {
  text: string;
  matched: boolean;
  time: string;
  mode?: "wake" | "finish";
}

function WakeWordSection() {
  const [enabled, setEnabled] = useState(false);
  const [phrase, setPhrase] = useState("whisper");
  const [finishPhrase, setFinishPhrase] = useState("");
  const [cancelPhrase, setCancelPhrase] = useState("");
  const [enterPhrase, setEnterPhrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{
    enabled: boolean;
    phrase: string;
    finishPhrase: string;
    cancelPhrase: string;
    enterPhrase: string;
    listening: boolean;
    paused: boolean;
    dictationActive: boolean;
    serverRunning: boolean;
  } | null>(null);
  const [heardLog, setHeardLog] = useState<WakeWordHeardEntry[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Load status on mount
  useEffect(() => {
    (window as any).electronAPI
      ?.wakeWordStatus()
      .then((s: any) => {
        if (s) {
          setEnabled(s.enabled);
          setPhrase(s.phrase || "whisper");
          setFinishPhrase(s.finishPhrase || "");
          setCancelPhrase(s.cancelPhrase || "");
          setEnterPhrase(s.enterPhrase || "");
          setStatus(s);
        }
      })
      .catch(() => {});
  }, []);

  // Subscribe to live transcription results
  useEffect(() => {
    const unsubscribe = (window as any).electronAPI?.onWakeWordHeard?.(
      (data: { text: string; matched: boolean; phrase: string; mode?: "wake" | "finish" }) => {
        const entry: WakeWordHeardEntry = {
          text: data.text,
          matched: data.matched,
          time: new Date().toLocaleTimeString(),
          mode: data.mode,
        };
        setHeardLog((prev) => {
          const next = [...prev, entry];
          return next.length > WAKE_WORD_LOG_MAX ? next.slice(-WAKE_WORD_LOG_MAX) : next;
        });
      }
    );
    return () => unsubscribe?.();
  }, []);

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [heardLog]);

  const [error, setError] = useState<string | null>(null);

  const handleToggle = async (newEnabled: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const result = await (window as any).electronAPI?.wakeWordToggle(newEnabled);
      if (result?.success) {
        setEnabled(result.enabled);
        setStatus(await (window as any).electronAPI?.wakeWordStatus());
        if (!newEnabled) setHeardLog([]);
      } else if (result?.error) {
        setError(result.error);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to toggle wake word");
    } finally {
      setLoading(false);
    }
  };

  const handlePhraseChange = async (newPhrase: string) => {
    setPhrase(newPhrase);
    try {
      await (window as any).electronAPI?.wakeWordSetPhrase(newPhrase);
    } catch {}
  };

  const handleFinishPhraseChange = async (newPhrase: string) => {
    setFinishPhrase(newPhrase);
    try {
      await (window as any).electronAPI?.wakeWordSetFinishPhrase(newPhrase);
    } catch {}
  };

  const handleCancelPhraseChange = async (newPhrase: string) => {
    setCancelPhrase(newPhrase);
    try {
      await (window as any).electronAPI?.wakeWordSetCancelPhrase(newPhrase);
    } catch {}
  };

  const handleEnterPhraseChange = async (newPhrase: string) => {
    setEnterPhrase(newPhrase);
    try {
      await (window as any).electronAPI?.wakeWordSetEnterPhrase(newPhrase);
    } catch {}
  };

  return (
    <div className="space-y-5">
      <div className="mb-3">
        <h3 className="text-[13px] font-semibold text-foreground tracking-tight">Wake Word</h3>
        <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-relaxed">
          Start and stop dictation by saying a magic word instead of pressing a hotkey.
        </p>
      </div>

      <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm divide-y divide-border/30 dark:divide-border-subtle/50">
        <div className="px-4 py-3.5">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <p className="text-[13px] font-medium text-foreground">Enable Wake Word</p>
              <p className="text-[11px] text-muted-foreground">
                {loading
                  ? "Starting wake word listener..."
                  : enabled
                    ? status?.listening
                      ? "Listening for wake word"
                      : "Enabled (server starting...)"
                    : "Voice activation is off"}
              </p>
            </div>
            <button
              onClick={() => handleToggle(!enabled)}
              disabled={loading}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
                enabled ? "bg-primary" : "bg-input"
              )}
            >
              <span
                className={cn(
                  "pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform duration-200 ease-in-out",
                  enabled ? "translate-x-4" : "translate-x-0"
                )}
              />
            </button>
          </div>
        </div>

        <div className="px-4 py-3.5">
          <div className="space-y-2">
            <label className="text-[13px] font-medium text-foreground">Wake Phrase</label>
            <Input
              value={phrase}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handlePhraseChange(e.target.value)
              }
              placeholder="whisper"
              className="h-8 text-[13px]"
              disabled={loading}
            />
            <p className="text-[11px] text-muted-foreground">
              Say this word to start dictation.
            </p>
          </div>
        </div>

        <div className="px-4 py-3.5">
          <div className="space-y-2">
            <label className="text-[13px] font-medium text-foreground">Finish Phrase</label>
            <Input
              value={finishPhrase}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleFinishPhraseChange(e.target.value)
              }
              placeholder="over"
              className="h-8 text-[13px]"
              disabled={loading}
            />
            <p className="text-[11px] text-muted-foreground">
              Say this word to stop dictation. It will be stripped from the transcription.
              Leave empty to use the wake phrase for both start and stop.
            </p>
          </div>
        </div>

        <div className="px-4 py-3.5">
          <div className="space-y-2">
            <label className="text-[13px] font-medium text-foreground">Cancel Phrase</label>
            <Input
              value={cancelPhrase}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleCancelPhraseChange(e.target.value)
              }
              placeholder="cancel"
              className="h-8 text-[13px]"
              disabled={loading}
            />
            <p className="text-[11px] text-muted-foreground">
              Say this word to cancel dictation. The audio will be discarded without pasting.
            </p>
          </div>
        </div>

        <div className="px-4 py-3.5">
          <div className="space-y-2">
            <label className="text-[13px] font-medium text-foreground">Enter Phrase</label>
            <Input
              value={enterPhrase}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                handleEnterPhraseChange(e.target.value)
              }
              placeholder="send"
              className="h-8 text-[13px]"
              disabled={loading}
            />
            <p className="text-[11px] text-muted-foreground">
              Say this word to stop dictation and press Enter after pasting (e.g. to send a message).
            </p>
          </div>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3">
          <p className="text-[12px] text-red-700 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Live listener output */}
      {enabled && (
        <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm">
          <div className="px-4 py-2.5 border-b border-border/30 dark:border-border-subtle/50">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
              </span>
              <p className="text-[11px] font-medium text-muted-foreground">Listener Output</p>
            </div>
          </div>
          <div className="px-4 py-2 max-h-48 overflow-y-auto font-mono text-[11px] space-y-1">
            {heardLog.length === 0 ? (
              <p className="text-muted-foreground/60 py-2 text-center">
                Waiting for audio...
              </p>
            ) : (
              heardLog.map((entry, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-start gap-2 py-0.5",
                    entry.matched && "text-green-600 dark:text-green-400 font-semibold"
                  )}
                >
                  <span className="text-muted-foreground/50 shrink-0">{entry.time}</span>
                  <span className="flex-1 break-words">
                    {entry.matched
                      ? `[${entry.mode === "cancel" ? "CANCEL" : entry.mode === "enter" ? "ENTER" : entry.mode === "finish" ? "FINISH" : "WAKE"}] ${entry.text}`
                      : entry.text}
                  </span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border/50 dark:border-border-subtle/70 bg-card/50 dark:bg-surface-2/50 backdrop-blur-sm">
        <div className="px-4 py-3">
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Uses the base Whisper model (~142 MB) to continuously listen for your wake phrase.
            Runs in the background with minimal resource usage. The listener automatically pauses
            during active dictation and resumes when done.
          </p>
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-[13px] font-semibold text-foreground tracking-tight">{title}</h3>
      {description && (
        <p className="text-[11px] text-muted-foreground/80 mt-0.5 leading-relaxed">{description}</p>
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
  const { t, i18n } = useTranslation();
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
                  <span className="text-[12px] font-medium text-foreground">
                    {t("settingsPage.transcription.openwhisprCloud")}
                  </span>
                  {isCloudMode && (
                    <span className="text-[10px] font-medium text-primary bg-primary/10 dark:bg-primary/15 px-1.5 py-px rounded-sm">
                      {t("common.active")}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground/80 mt-0.5">
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
                  <span className="text-[12px] font-medium text-foreground">
                    {t("settingsPage.transcription.customSetup")}
                  </span>
                  {isCustomMode && (
                    <span className="text-[10px] font-medium text-accent bg-accent/10 dark:bg-accent/15 px-1.5 py-px rounded-sm">
                      {t("common.active")}
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground/80 mt-0.5">
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
  const { t, i18n } = useTranslation();
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
                      <span className="text-[12px] font-medium text-foreground">
                        {t("settingsPage.aiModels.openwhisprCloud")}
                      </span>
                      {isCloudMode && (
                        <span className="text-[10px] font-medium text-primary bg-primary/10 dark:bg-primary/15 px-1.5 py-px rounded-sm">
                          {t("common.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground/80 mt-0.5">
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
                      <span className="text-[12px] font-medium text-foreground">
                        {t("settingsPage.aiModels.customSetup")}
                      </span>
                      {isCustomMode && (
                        <span className="text-[10px] font-medium text-accent bg-accent/10 dark:bg-accent/15 px-1.5 py-px rounded-sm">
                          {t("common.active")}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground/80 mt-0.5">
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
              useReasoningModel={useReasoningModel}
              setUseReasoningModel={setUseReasoningModel}
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
              showAlertDialog={showAlertDialog}
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
    customDictionary,
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
    setCustomDictionary,
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

  const platform = useMemo(() => {
    if (typeof window !== "undefined" && window.electronAPI?.getPlatform) {
      return window.electronAPI.getPlatform();
    }
    return "linux";
  }, []);

  const [newDictionaryWord, setNewDictionaryWord] = useState("");

  const handleAddDictionaryWord = useCallback(() => {
    const word = newDictionaryWord.trim();
    if (word && !customDictionary.includes(word)) {
      setCustomDictionary([...customDictionary, word]);
      setNewDictionaryWord("");
    }
  }, [newDictionaryWord, customDictionary, setCustomDictionary]);

  const handleRemoveDictionaryWord = useCallback(
    (wordToRemove: string) => {
      if (wordToRemove === agentName) return;
      setCustomDictionary(customDictionary.filter((word) => word !== wordToRemove));
    },
    [customDictionary, setCustomDictionary, agentName]
  );

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
  }, [whisperHook, getAppVersion]);

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
                        <p className="text-[13px] font-medium text-foreground truncate">
                          {user.name || t("settingsPage.account.user")}
                        </p>
                        <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
                      </div>
                      <Badge variant="success">{t("settingsPage.account.signedIn")}</Badge>
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>

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
                          <Badge variant="success">{t("settingsPage.account.badges.pro")}</Badge>
                        ) : usage.isOverLimit ? (
                          <Badge variant="warning">
                            {t("settingsPage.account.badges.limitReached")}
                          </Badge>
                        ) : (
                          <Badge variant="outline">{t("settingsPage.account.badges.free")}</Badge>
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
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
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
                            const result = await usage.openCheckout();
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
                        <p className="text-[13px] font-medium text-foreground">
                          {t("settingsPage.account.trialCta.title")}
                        </p>
                        <p className="text-[11px] text-muted-foreground leading-relaxed mt-0.5">
                          {t("settingsPage.account.trialCta.description")}
                        </p>
                      </div>
                      <Button
                        onClick={() => {
                          localStorage.setItem("pendingCloudMigration", "true");
                          localStorage.setItem("onboardingCurrentStep", "0");
                          localStorage.removeItem("onboardingCompleted");
                          window.location.reload();
                        }}
                        size="sm"
                        className="w-full"
                      >
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

      case "general":
        return (
          <div className="space-y-6">
            {/* Updates */}
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
                      <span className="text-[13px] tabular-nums text-muted-foreground font-mono">
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
                        } catch (error: any) {
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
                            } catch (error: any) {
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
                              className="h-full bg-success transition-all duration-200 rounded-full"
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
                              } catch (error: any) {
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
                      <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
                        {t("settingsPage.general.updates.whatsNew", {
                          version: updateInfo.version,
                        })}
                      </p>
                      <div className="text-[12px] text-muted-foreground">
                        <MarkdownRenderer content={updateInfo.releaseNotes} />
                      </div>
                    </div>
                  )}
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

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
                              flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-[11px] font-medium
                              transition-all duration-100
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
                </SettingsPanelRow>

                {!isUsingGnomeHotkeys && (
                  <SettingsPanelRow>
                    <p className="text-[11px] font-medium text-muted-foreground/80 mb-2">
                      {t("settingsPage.general.hotkey.activationMode")}
                    </p>
                    <ActivationModeSelector value={activationMode} onChange={setActivationMode} />
                  </SettingsPanelRow>
                )}
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

      case "dictionary":
        return (
          <div className="space-y-5">
            <SectionHeader
              title={t("settingsPage.dictionary.title")}
              description={t("settingsPage.dictionary.description")}
            />

            {/* Add Words */}
            <SettingsPanel>
              <SettingsPanelRow>
                <div className="space-y-2">
                  <p className="text-[12px] font-medium text-foreground">
                    {t("settingsPage.dictionary.addWordOrPhrase")}
                  </p>
                  <div className="flex gap-2">
                    <Input
                      placeholder={t("settingsPage.dictionary.placeholder")}
                      value={newDictionaryWord}
                      onChange={(e) => setNewDictionaryWord(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          handleAddDictionaryWord();
                        }
                      }}
                      className="flex-1 h-8 text-[12px]"
                    />
                    <Button
                      onClick={handleAddDictionaryWord}
                      disabled={!newDictionaryWord.trim()}
                      size="sm"
                      className="h-8"
                    >
                      {t("settingsPage.dictionary.add")}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground/50">
                    {t("settingsPage.dictionary.pressEnterToAdd")}
                  </p>
                </div>
              </SettingsPanelRow>
            </SettingsPanel>

            {/* Word List */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[12px] font-medium text-foreground">
                  {t("settingsPage.dictionary.yourWords")}
                  {customDictionary.length > 0 && (
                    <span className="ml-1.5 text-muted-foreground/50 font-normal text-[11px]">
                      {customDictionary.length}
                    </span>
                  )}
                </p>
                {customDictionary.length > 0 && (
                  <button
                    onClick={() => {
                      showConfirmDialog({
                        title: t("settingsPage.dictionary.clearDictionaryTitle"),
                        description: t("settingsPage.dictionary.clearDictionaryDescription"),
                        confirmText: t("settingsPage.dictionary.clearAll"),
                        variant: "destructive",
                        onConfirm: () =>
                          setCustomDictionary(customDictionary.filter((w) => w === agentName)),
                      });
                    }}
                    className="text-[10px] text-muted-foreground/40 hover:text-destructive transition-colors"
                  >
                    {t("settingsPage.dictionary.clearAll")}
                  </button>
                )}
              </div>

              {customDictionary.length > 0 ? (
                <SettingsPanel>
                  <SettingsPanelRow>
                    <div className="flex flex-wrap gap-1">
                      {customDictionary.map((word) => {
                        const isAgentName = word === agentName;
                        return (
                          <span
                            key={word}
                            className={`group inline-flex items-center gap-0.5 py-0.5 rounded-[5px] text-[11px] border transition-all ${
                              isAgentName
                                ? "pl-2 pr-2 bg-primary/10 dark:bg-primary/15 text-primary border-primary/20 dark:border-primary/30"
                                : "pl-2 pr-1 bg-primary/5 dark:bg-primary/10 text-foreground border-border/30 dark:border-border-subtle hover:border-destructive/40 hover:bg-destructive/5"
                            }`}
                            title={
                              isAgentName
                                ? t("settingsPage.dictionary.agentNameAutoManaged")
                                : undefined
                            }
                          >
                            {word}
                            {!isAgentName && (
                              <button
                                onClick={() => handleRemoveDictionaryWord(word)}
                                className="ml-0.5 p-0.5 rounded-sm text-muted-foreground/40 hover:text-destructive transition-colors"
                                title={t("settingsPage.dictionary.removeWord")}
                              >
                                <svg
                                  width="9"
                                  height="9"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                >
                                  <path d="M18 6L6 18M6 6l12 12" />
                                </svg>
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  </SettingsPanelRow>
                </SettingsPanel>
              ) : (
                <div className="rounded-lg border border-dashed border-border/40 dark:border-border-subtle py-6 flex flex-col items-center justify-center text-center">
                  <p className="text-[11px] text-muted-foreground/50">
                    {t("settingsPage.dictionary.noWords")}
                  </p>
                  <p className="text-[10px] text-muted-foreground/40 mt-0.5">
                    {t("settingsPage.dictionary.wordsAppearHere")}
                  </p>
                </div>
              )}
            </div>

            {/* How it works */}
            <div>
              <SectionHeader title={t("settingsPage.dictionary.howItWorksTitle")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    {t("settingsPage.dictionary.howItWorksDescription")}
                  </p>
                </SettingsPanelRow>
                <SettingsPanelRow>
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    <span className="font-medium text-foreground">
                      {t("settingsPage.dictionary.tipLabel")}
                    </span>{" "}
                    {t("settingsPage.dictionary.tipDescription")}
                  </p>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );

      case "aiModels":
        return (
          <AiModelsSection
            isSignedIn={isSignedIn ?? false}
            cloudReasoningMode={cloudReasoningMode}
            setCloudReasoningMode={setCloudReasoningMode}
            useReasoningModel={useReasoningModel}
            setUseReasoningModel={(value) => {
              setUseReasoningModel(value);
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
        );

      case "agentConfig":
        return (
          <div className="space-y-5">
            <SectionHeader
              title={t("settingsPage.agentConfig.title")}
              description={t("settingsPage.agentConfig.description")}
            />

            {/* Agent Name */}
            <div>
              <p className="text-[13px] font-medium text-foreground mb-3">
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
                          setAgentName(trimmed);
                          setAgentNameInput(trimmed);
                          showAlertDialog({
                            title: t("settingsPage.agentConfig.dialogs.updatedTitle"),
                            description: t("settingsPage.agentConfig.dialogs.updatedDescription", {
                              name: trimmed,
                            }),
                          });
                        }}
                        disabled={!agentNameInput.trim()}
                        size="sm"
                      >
                        {t("settingsPage.agentConfig.save")}
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground/60">
                      {t("settingsPage.agentConfig.helper")}
                    </p>
                  </div>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* How it works */}
            <div>
              <SectionHeader title={t("settingsPage.agentConfig.howItWorksTitle")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <p className="text-[12px] text-muted-foreground leading-relaxed">
                    {t("settingsPage.agentConfig.howItWorksDescription", { agentName })}
                  </p>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>

            {/* Examples */}
            <div>
              <SectionHeader title={t("settingsPage.agentConfig.examplesTitle")} />
              <SettingsPanel>
                <SettingsPanelRow>
                  <div className="space-y-2.5">
                    {[
                      {
                        input: `Hey ${agentName}, write a formal email about the budget`,
                        mode: t("settingsPage.agentConfig.instructionMode"),
                      },
                      {
                        input: `Hey ${agentName}, make this more professional`,
                        mode: t("settingsPage.agentConfig.instructionMode"),
                      },
                      {
                        input: `Hey ${agentName}, convert this to bullet points`,
                        mode: t("settingsPage.agentConfig.instructionMode"),
                      },
                      {
                        input: t("settingsPage.agentConfig.cleanupExample"),
                        mode: t("settingsPage.agentConfig.cleanupMode"),
                      },
                    ].map((example, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <span
                          className={`shrink-0 mt-0.5 text-[10px] font-medium uppercase tracking-wider px-1.5 py-px rounded ${
                            example.mode === t("settingsPage.agentConfig.instructionMode")
                              ? "bg-primary/10 text-primary dark:bg-primary/15"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {example.mode}
                        </span>
                        <p className="text-[12px] text-muted-foreground leading-relaxed">
                          "{example.input}"
                        </p>
                      </div>
                    ))}
                  </div>
                </SettingsPanelRow>
              </SettingsPanel>
            </div>
          </div>
        );

      case "prompts":
        return (
          <div className="space-y-5">
            <SectionHeader
              title={t("settingsPage.prompts.title")}
              description={t("settingsPage.prompts.description")}
            />

            <PromptStudio />
          </div>
        );

      case "wakeWord":
        return <WakeWordSection />;

      case "privacy":
        return (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-2">
                {t("settingsPage.privacy.title")}
              </h3>
              <p className="text-sm text-muted-foreground mb-6">
                {t("settingsPage.privacy.description")}
              </p>
            </div>

            {isSignedIn && (
              <SettingsPanel>
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
        );

      case "permissions":
        return (
          <div className="space-y-5">
            <SectionHeader
              title={t("settingsPage.permissions.title")}
              description={t("settingsPage.permissions.description")}
            />

            {/* Permission Cards - matching onboarding style */}
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

            {/* Error state for microphone */}
            {!permissionsHook.micPermissionGranted && permissionsHook.micPermissionError && (
              <MicPermissionWarning
                error={permissionsHook.micPermissionError}
                onOpenSoundSettings={permissionsHook.openSoundInputSettings}
                onOpenPrivacySettings={permissionsHook.openMicPrivacySettings}
              />
            )}

            {/* Linux paste tools info */}
            {platform === "linux" &&
              permissionsHook.pasteToolsInfo &&
              !permissionsHook.pasteToolsInfo.available && (
                <PasteToolsInfo
                  pasteToolsInfo={permissionsHook.pasteToolsInfo}
                  isChecking={permissionsHook.isCheckingPasteTools}
                  onCheck={permissionsHook.checkPasteToolsAvailability}
                />
              )}

            {/* Troubleshooting section for macOS */}
            {platform === "darwin" && (
              <div>
                <p className="text-[13px] font-medium text-foreground mb-3">
                  {t("settingsPage.permissions.troubleshootingTitle")}
                </p>
                <SettingsPanel>
                  <SettingsPanelRow>
                    <SettingsRow
                      label={t("settingsPage.permissions.resetAccessibility.label")}
                      description={t("settingsPage.permissions.resetAccessibility.rowDescription")}
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
        );

      case "developer":
        return (
          <div className="space-y-6">
            <DeveloperSection />

            {/* Data Management — moved from General */}
            <div className="border-t border-border/40 pt-8">
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
