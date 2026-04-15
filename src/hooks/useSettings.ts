import React, { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { useSettingsStore, initializeSettings } from "../stores/settingsStore";
import logger from "../utils/logger";
import { useLocalStorage } from "./useLocalStorage";
import type { LocalTranscriptionProvider, InferenceMode, SelfHostedType } from "../types/electron";

export interface TranscriptionSettings {
  uiLanguage: string;
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  preferredLanguage: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl?: string;
  cloudTranscriptionMode: string;
  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  customDictionary: string[];
  assemblyAiStreaming: boolean;
}

export interface ReasoningSettings {
  useReasoningModel: boolean;
  reasoningModel: string;
  reasoningProvider: string;
  cloudReasoningBaseUrl?: string;
  cloudReasoningMode: string;
  reasoningMode: InferenceMode;
  remoteReasoningType: SelfHostedType;
  remoteReasoningUrl: string;
}

export interface HotkeySettings {
  dictationKey: string;
  meetingKey: string;
  activationMode: "tap" | "push";
}

export interface MicrophoneSettings {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
}

export interface ApiKeySettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;
  mistralApiKey: string;
  deepgramApiKey: string;
  customTranscriptionApiKey: string;
  customReasoningApiKey: string;
}

export interface PrivacySettings {
  cloudBackupEnabled: boolean;
  telemetryEnabled: boolean;
  audioRetentionDays: number;
  dataRetentionEnabled: boolean;
}

export interface ThemeSettings {
  theme: "light" | "dark" | "auto";
}

export interface AgentModeSettings {
  agentModel: string;
  agentProvider: string;
  agentKey: string;
  agentSystemPrompt: string;
  agentEnabled: boolean;
  cloudAgentMode: string;
  agentInferenceMode: InferenceMode;
  remoteAgentUrl: string;
}

function useSettingsInternal() {
  const store = useSettingsStore();
  const { setCustomDictionary } = store;

  // One-time initialization: sync API keys, dictation key, activation mode,
  // UI language, and dictionary from the main process / SQLite.
  const hasInitialized = useRef(false);
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    initializeSettings().catch((err) => {
      logger.warn(
        "Failed to initialize settings store",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, []);

  // Listen for dictionary updates from main process (auto-learn corrections)
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.onDictionaryUpdated) return;
    const unsubscribe = window.electronAPI.onDictionaryUpdated((words: string[]) => {
      if (Array.isArray(words)) {
        setCustomDictionary(words);
      }
    });
    return unsubscribe;
  }, [setCustomDictionary]);

  // Auto-learn corrections from user edits in external apps
  const [autoLearnCorrections, setAutoLearnCorrectionsRaw] = useLocalStorage(
    "autoLearnCorrections",
    true,
    {
      serialize: String,
      deserialize: (value: string) => value !== "false",
    }
  );

  const setAutoLearnCorrections = useCallback(
    (enabled: boolean) => {
      setAutoLearnCorrectionsRaw(enabled);
      window.electronAPI?.setAutoLearnEnabled?.(enabled);
    },
    [setAutoLearnCorrectionsRaw]
  );

  // Sync auto-learn state to main process on mount
  useEffect(() => {
    window.electronAPI?.setAutoLearnEnabled?.(autoLearnCorrections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync startup pre-warming preferences to main process
  const {
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    reasoningProvider,
    reasoningModel,
  } = store;

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.syncStartupPreferences) return;

    const model = localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
    window.electronAPI
      .syncStartupPreferences({
        useLocalWhisper,
        localTranscriptionProvider,
        model: model || undefined,
        reasoningProvider,
        reasoningModel: reasoningProvider === "local" ? reasoningModel : undefined,
      })
      .catch((err) =>
        logger.warn(
          "Failed to sync startup preferences",
          { error: (err as Error).message },
          "settings"
        )
      );
  }, [
    useLocalWhisper,
    localTranscriptionProvider,
    whisperModel,
    parakeetModel,
    reasoningProvider,
    reasoningModel,
  ]);

  return {
    useLocalWhisper: store.useLocalWhisper,
    whisperModel: store.whisperModel,
    uiLanguage: store.uiLanguage,
    localTranscriptionProvider: store.localTranscriptionProvider,
    parakeetModel: store.parakeetModel,
    allowOpenAIFallback: store.allowOpenAIFallback,
    allowLocalFallback: store.allowLocalFallback,
    fallbackWhisperModel: store.fallbackWhisperModel,
    preferredLanguage: store.preferredLanguage,
    cloudTranscriptionProvider: store.cloudTranscriptionProvider,
    cloudTranscriptionModel: store.cloudTranscriptionModel,
    cloudTranscriptionBaseUrl: store.cloudTranscriptionBaseUrl,
    cloudReasoningBaseUrl: store.cloudReasoningBaseUrl,
    cloudTranscriptionMode: store.cloudTranscriptionMode,
    cloudReasoningMode: store.cloudReasoningMode,
    transcriptionMode: store.transcriptionMode,
    remoteTranscriptionType: store.remoteTranscriptionType,
    remoteTranscriptionUrl: store.remoteTranscriptionUrl,
    reasoningMode: store.reasoningMode,
    remoteReasoningType: store.remoteReasoningType,
    remoteReasoningUrl: store.remoteReasoningUrl,
    customDictionary: store.customDictionary,
    assemblyAiStreaming: store.assemblyAiStreaming,
    setAssemblyAiStreaming: store.setAssemblyAiStreaming,
    useReasoningModel: store.useReasoningModel,
    reasoningModel: store.reasoningModel,
    reasoningProvider: store.reasoningProvider,
    openaiApiKey: store.openaiApiKey,
    anthropicApiKey: store.anthropicApiKey,
    geminiApiKey: store.geminiApiKey,
    groqApiKey: store.groqApiKey,
    mistralApiKey: store.mistralApiKey,
    deepgramApiKey: store.deepgramApiKey,
    dictationKey: store.dictationKey,
    meetingKey: store.meetingKey,
    theme: store.theme,
    setUseLocalWhisper: store.setUseLocalWhisper,
    setWhisperModel: store.setWhisperModel,
    setUiLanguage: store.setUiLanguage,
    setLocalTranscriptionProvider: store.setLocalTranscriptionProvider,
    setParakeetModel: store.setParakeetModel,
    setAllowOpenAIFallback: store.setAllowOpenAIFallback,
    setAllowLocalFallback: store.setAllowLocalFallback,
    setFallbackWhisperModel: store.setFallbackWhisperModel,
    setPreferredLanguage: store.setPreferredLanguage,
    setCloudTranscriptionProvider: store.setCloudTranscriptionProvider,
    setCloudTranscriptionModel: store.setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl: store.setCloudTranscriptionBaseUrl,
    setCloudReasoningBaseUrl: store.setCloudReasoningBaseUrl,
    setCloudTranscriptionMode: store.setCloudTranscriptionMode,
    setCloudReasoningMode: store.setCloudReasoningMode,
    setTranscriptionMode: store.setTranscriptionMode,
    setRemoteTranscriptionType: store.setRemoteTranscriptionType,
    setRemoteTranscriptionUrl: store.setRemoteTranscriptionUrl,
    setReasoningMode: store.setReasoningMode,
    setRemoteReasoningType: store.setRemoteReasoningType,
    setRemoteReasoningUrl: store.setRemoteReasoningUrl,
    setCustomDictionary: store.setCustomDictionary,
    setUseReasoningModel: store.setUseReasoningModel,
    setReasoningModel: store.setReasoningModel,
    setReasoningProvider: store.setReasoningProvider,
    setOpenaiApiKey: store.setOpenaiApiKey,
    setAnthropicApiKey: store.setAnthropicApiKey,
    setGeminiApiKey: store.setGeminiApiKey,
    setGroqApiKey: store.setGroqApiKey,
    setMistralApiKey: store.setMistralApiKey,
    setDeepgramApiKey: store.setDeepgramApiKey,
    customTranscriptionApiKey: store.customTranscriptionApiKey,
    setCustomTranscriptionApiKey: store.setCustomTranscriptionApiKey,
    customReasoningApiKey: store.customReasoningApiKey,
    setCustomReasoningApiKey: store.setCustomReasoningApiKey,
    setDictationKey: store.setDictationKey,
    setMeetingKey: store.setMeetingKey,
    setTheme: store.setTheme,
    activationMode: store.activationMode,
    setActivationMode: store.setActivationMode,
    audioCuesEnabled: store.audioCuesEnabled,
    setAudioCuesEnabled: store.setAudioCuesEnabled,
    pauseMediaOnDictation: store.pauseMediaOnDictation,
    setPauseMediaOnDictation: store.setPauseMediaOnDictation,
    floatingIconAutoHide: store.floatingIconAutoHide,
    setFloatingIconAutoHide: store.setFloatingIconAutoHide,
    startMinimized: store.startMinimized,
    setStartMinimized: store.setStartMinimized,
    panelStartPosition: store.panelStartPosition,
    setPanelStartPosition: store.setPanelStartPosition,
    preferBuiltInMic: store.preferBuiltInMic,
    selectedMicDeviceId: store.selectedMicDeviceId,
    setPreferBuiltInMic: store.setPreferBuiltInMic,
    setSelectedMicDeviceId: store.setSelectedMicDeviceId,
    autoLearnCorrections,
    setAutoLearnCorrections,
    keepTranscriptionInClipboard: store.keepTranscriptionInClipboard,
    setKeepTranscriptionInClipboard: store.setKeepTranscriptionInClipboard,
    noteFilesEnabled: store.noteFilesEnabled,
    setNoteFilesEnabled: store.setNoteFilesEnabled,
    noteFilesPath: store.noteFilesPath,
    setNoteFilesPath: store.setNoteFilesPath,
    cloudBackupEnabled: store.cloudBackupEnabled,
    setCloudBackupEnabled: store.setCloudBackupEnabled,
    telemetryEnabled: store.telemetryEnabled,
    setTelemetryEnabled: store.setTelemetryEnabled,
    audioRetentionDays: store.audioRetentionDays,
    setAudioRetentionDays: store.setAudioRetentionDays,
    dataRetentionEnabled: store.dataRetentionEnabled,
    setDataRetentionEnabled: store.setDataRetentionEnabled,
    updateTranscriptionSettings: store.updateTranscriptionSettings,
    updateReasoningSettings: store.updateReasoningSettings,
    updateApiKeys: store.updateApiKeys,
  };
}

export type SettingsValue = ReturnType<typeof useSettingsInternal>;

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const value = useSettingsInternal();
  return React.createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    throw new Error("useSettings must be used within a SettingsProvider");
  }
  return ctx;
}
