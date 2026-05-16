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
  showTranscriptionPreview: boolean;
}

export interface CleanupSettings {
  autoGenerateNoteTitle: boolean;
  useCleanupModel: boolean;
  useDictationAgent: boolean;
  cleanupModel: string;
  cleanupProvider: string;
  cleanupCloudBaseUrl?: string;
  cleanupCloudMode: string;
  cleanupMode: InferenceMode;
  cleanupRemoteUrl: string;
}

export interface HotkeySettings {
  dictationKey: string;
  meetingKey: string;
  meetingHotkeyLayoutMode: "side-panel" | "full-width";
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
  openrouterApiKey: string;
  customTranscriptionApiKey: string;
  cleanupCustomApiKey: string;
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

export interface ChatAgentSettings {
  chatAgentModel: string;
  chatAgentProvider: string;
  chatAgentKey: string;
  chatAgentCloudMode: string;
  chatAgentMode: InferenceMode;
  chatAgentCloudBaseUrl: string;
  chatAgentRemoteUrl: string;
  chatAgentCustomApiKey: string;
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
    cleanupProvider,
    cleanupModel,
    dictationAgentProvider,
    dictationAgentModel,
  } = store;

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.syncStartupPreferences) return;

    const model = localTranscriptionProvider === "nvidia" ? parakeetModel : whisperModel;
    window.electronAPI
      .syncStartupPreferences({
        useLocalWhisper,
        localTranscriptionProvider,
        model: model || undefined,
        cleanupProvider,
        cleanupModel: cleanupProvider === "local" ? cleanupModel : undefined,
        dictationAgentProvider,
        dictationAgentModel: dictationAgentProvider === "local" ? dictationAgentModel : undefined,
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
    cleanupProvider,
    cleanupModel,
    dictationAgentProvider,
    dictationAgentModel,
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
    cleanupCloudBaseUrl: store.cleanupCloudBaseUrl,
    cloudTranscriptionMode: store.cloudTranscriptionMode,
    cleanupCloudMode: store.cleanupCloudMode,
    transcriptionMode: store.transcriptionMode,
    remoteTranscriptionType: store.remoteTranscriptionType,
    remoteTranscriptionUrl: store.remoteTranscriptionUrl,
    cleanupMode: store.cleanupMode,
    cleanupRemoteUrl: store.cleanupRemoteUrl,
    customDictionary: store.customDictionary,
    assemblyAiStreaming: store.assemblyAiStreaming,
    setAssemblyAiStreaming: store.setAssemblyAiStreaming,
    autoGenerateNoteTitle: store.autoGenerateNoteTitle,
    setAutoGenerateNoteTitle: store.setAutoGenerateNoteTitle,
    useCleanupModel: store.useCleanupModel,
    useDictationAgent: store.useDictationAgent,
    cleanupModel: store.cleanupModel,
    cleanupProvider: store.cleanupProvider,
    openaiApiKey: store.openaiApiKey,
    anthropicApiKey: store.anthropicApiKey,
    geminiApiKey: store.geminiApiKey,
    groqApiKey: store.groqApiKey,
    mistralApiKey: store.mistralApiKey,
    openrouterApiKey: store.openrouterApiKey,
    dictationKey: store.dictationKey,
    meetingKey: store.meetingKey,
    meetingHotkeyLayoutMode: store.meetingHotkeyLayoutMode,
    setMeetingHotkeyLayoutMode: store.setMeetingHotkeyLayoutMode,
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
    setCloudTranscriptionMode: store.setCloudTranscriptionMode,
    setCleanupCloudBaseUrl: store.setCleanupCloudBaseUrl,
    setCleanupCloudMode: store.setCleanupCloudMode,
    setTranscriptionMode: store.setTranscriptionMode,
    setRemoteTranscriptionType: store.setRemoteTranscriptionType,
    setRemoteTranscriptionUrl: store.setRemoteTranscriptionUrl,
    setCleanupMode: store.setCleanupMode,
    setCleanupRemoteUrl: store.setCleanupRemoteUrl,
    setCustomDictionary: store.setCustomDictionary,
    setUseCleanupModel: store.setUseCleanupModel,
    setUseDictationAgent: store.setUseDictationAgent,
    setCleanupModel: store.setCleanupModel,
    setCleanupProvider: store.setCleanupProvider,
    setOpenaiApiKey: store.setOpenaiApiKey,
    setAnthropicApiKey: store.setAnthropicApiKey,
    setGeminiApiKey: store.setGeminiApiKey,
    setGroqApiKey: store.setGroqApiKey,
    setMistralApiKey: store.setMistralApiKey,
    setOpenRouterApiKey: store.setOpenRouterApiKey,
    customTranscriptionApiKey: store.customTranscriptionApiKey,
    setCustomTranscriptionApiKey: store.setCustomTranscriptionApiKey,
    cleanupCustomApiKey: store.cleanupCustomApiKey,
    setCleanupCustomApiKey: store.setCleanupCustomApiKey,
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
    showTranscriptionPreview: store.showTranscriptionPreview,
    setShowTranscriptionPreview: store.setShowTranscriptionPreview,
    autoPasteEnabled: store.autoPasteEnabled,
    setAutoPasteEnabled: store.setAutoPasteEnabled,
    keepTranscriptionInClipboard: store.keepTranscriptionInClipboard,
    setKeepTranscriptionInClipboard: store.setKeepTranscriptionInClipboard,
    noteFilesEnabled: store.noteFilesEnabled,
    setNoteFilesEnabled: store.setNoteFilesEnabled,
    noteFilesPath: store.noteFilesPath,
    setNoteFilesPath: store.setNoteFilesPath,
    dictationSileroEnabled: store.dictationSileroEnabled,
    setDictationSileroEnabled: store.setDictationSileroEnabled,
    noteRecordingSileroEnabled: store.noteRecordingSileroEnabled,
    setNoteRecordingSileroEnabled: store.setNoteRecordingSileroEnabled,
    meetingSileroEnabled: store.meetingSileroEnabled,
    setMeetingSileroEnabled: store.setMeetingSileroEnabled,
    whisperVadThreshold: store.whisperVadThreshold,
    setWhisperVadThreshold: store.setWhisperVadThreshold,
    whisperVadMinSpeechDurationMs: store.whisperVadMinSpeechDurationMs,
    setWhisperVadMinSpeechDurationMs: store.setWhisperVadMinSpeechDurationMs,
    whisperVadMinSilenceDurationMs: store.whisperVadMinSilenceDurationMs,
    setWhisperVadMinSilenceDurationMs: store.setWhisperVadMinSilenceDurationMs,
    whisperVadMaxSpeechDurationS: store.whisperVadMaxSpeechDurationS,
    setWhisperVadMaxSpeechDurationS: store.setWhisperVadMaxSpeechDurationS,
    whisperVadSpeechPadMs: store.whisperVadSpeechPadMs,
    setWhisperVadSpeechPadMs: store.setWhisperVadSpeechPadMs,
    whisperVadSamplesOverlap: store.whisperVadSamplesOverlap,
    setWhisperVadSamplesOverlap: store.setWhisperVadSamplesOverlap,
    cloudBackupEnabled: store.cloudBackupEnabled,
    setCloudBackupEnabled: store.setCloudBackupEnabled,
    telemetryEnabled: store.telemetryEnabled,
    setTelemetryEnabled: store.setTelemetryEnabled,
    audioRetentionDays: store.audioRetentionDays,
    setAudioRetentionDays: store.setAudioRetentionDays,
    dataRetentionEnabled: store.dataRetentionEnabled,
    setDataRetentionEnabled: store.setDataRetentionEnabled,
    updateTranscriptionSettings: store.updateTranscriptionSettings,
    updateCleanupSettings: store.updateCleanupSettings,
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
