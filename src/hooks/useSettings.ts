import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  useSettingsStore,
  initializeSettings,
  selectLocalServerPrefs,
} from "../stores/settingsStore";
import logger from "../utils/logger";
import { useLocalStorage } from "./useLocalStorage";
import type {
  ChineseScriptPreference,
  LocalTranscriptionProvider,
  InferenceMode,
  SelfHostedType,
} from "../types/electron";
import type { Snippet } from "../utils/snippets";
import {
  effectiveAudioRetentionDays,
  effectiveLocalHistoryEnabled,
  isLocalHistoryPolicyResolved,
  isPolicySettled,
} from "../stores/policyRules";
import { usePolicyStore } from "../stores/policyStore";
import { usePolicySnapshot } from "./usePolicy";
import { subscribeAgentNameChanges } from "../utils/agentName";

export interface TranscriptionSettings {
  uiLanguage: string;
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  cohereModel: string;
  allowOpenAIFallback: boolean;
  allowLocalFallback: boolean;
  fallbackWhisperModel: string;
  preferredLanguage: string;
  /** When transcription language is Auto, force Chinese output script. See #975. */
  chineseScriptPreference: ChineseScriptPreference;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl?: string;
  cloudTranscriptionMode: string;
  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  remoteTranscriptionModel: string;
  customDictionary: string[];
  snippets: Snippet[];
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
  /** Hotkeys actually registered by the main process (may be a subset of
   * dictationKey, e.g. primary-only on GNOME/KDE/Hyprland). Display-only. */
  activeDictationKey: string | null;
  meetingKey: string;
  voiceAgentKey: string;
  meetingHotkeyLayoutMode: "side-panel" | "full-width";
  activationMode: "tap" | "push";
}

export interface OnboardingSettings {
  onboardingUseCases: string[];
  onboardingUseCaseNote: string;
  spokenLanguages: string[];
}

export interface MicrophoneSettings {
  microphoneSelectionMode: "system" | "built-in" | "specific";
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  selectedMicDeviceLabel: string;
  micWarmHoldSeconds: number;
}

export interface ApiKeySettings {
  openaiApiKey: string;
  anthropicApiKey: string;
  geminiApiKey: string;
  groqApiKey: string;
  xaiApiKey: string;
  mistralApiKey: string;
  openrouterApiKey: string;
  cortiClientId: string;
  cortiClientSecret: string;
  cortiApiKey: string;
  tinfoilApiKey: string;
  deepgramApiKey: string;
  assemblyaiApiKey: string;
  customTranscriptionApiKey: string;
  cleanupCustomApiKey: string;
}

export interface PrivacySettings {
  cloudBackupEnabled: boolean;
  insightsSyncEnabled: boolean;
  telemetryEnabled: boolean;
  audioRetentionDays: number;
  transcriptRetentionDays: number;
  dataRetentionEnabled: boolean;
  saveDiscardedTranscriptions: boolean;
}

export interface ThemeSettings {
  theme: "light" | "dark" | "auto";
}

export interface ChatAgentSettings {
  chatAgentModel: string;
  chatAgentProvider: string;
  chatAgentCloudMode: string;
  chatAgentMode: InferenceMode;
  chatAgentCloudBaseUrl: string;
  chatAgentRemoteUrl: string;
  chatAgentCustomApiKey: string;
}

interface AutoLearnCorrectionsValue {
  autoLearnCorrections: boolean;
  setAutoLearnCorrections: (enabled: boolean) => void;
}

const AutoLearnCorrectionsContext = createContext<AutoLearnCorrectionsValue | null>(null);

function useSettingsLifecycle(): AutoLearnCorrectionsValue {
  const applyCustomDictionaryFromExternal = useSettingsStore(
    (settings) => settings.applyCustomDictionaryFromExternal
  );
  const applySnippetsFromExternal = useSettingsStore(
    (settings) => settings.applySnippetsFromExternal
  );

  useEffect(() => {
    initializeSettings().catch((err) => {
      logger.warn(
        "Failed to initialize settings store",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, []);

  useEffect(subscribeAgentNameChanges, []);

  // Startup sends the initial snapshot before hydration; subscribe only to changes.
  useEffect(
    () =>
      useSettingsStore.subscribe((state, previous) => {
        if (
          state.notificationsEnabled === previous.notificationsEnabled &&
          state.notifyMeetingDetection === previous.notifyMeetingDetection &&
          state.notifyCalendarReminders === previous.notifyCalendarReminders &&
          state.meetingProcessDetection === previous.meetingProcessDetection
        )
          return;
        window.electronAPI?.syncNotificationPreferences?.({
          notificationsEnabled: state.notificationsEnabled,
          notifyMeetingDetection: state.notifyMeetingDetection,
          notifyCalendarReminders: state.notifyCalendarReminders,
          meetingProcessDetection: state.meetingProcessDetection,
        });
      }),
    []
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.onDictionaryUpdated) return;
    return window.electronAPI.onDictionaryUpdated((words: string[]) => {
      if (Array.isArray(words)) applyCustomDictionaryFromExternal(words);
    });
  }, [applyCustomDictionaryFromExternal]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.onSnippetsUpdated) return;
    return window.electronAPI.onSnippetsUpdated((snippets: Snippet[]) => {
      if (Array.isArray(snippets)) applySnippetsFromExternal(snippets);
    });
  }, [applySnippetsFromExternal]);

  const [autoLearnCorrections, setAutoLearnCorrectionsRaw] = useLocalStorage(
    "autoLearnCorrections",
    true,
    {
      serialize: String,
      deserialize: (value: string) => value !== "false",
    }
  );
  useEffect(() => {
    window.electronAPI?.setAutoLearnEnabled?.(autoLearnCorrections);
  }, [autoLearnCorrections]);

  const audioRetentionDays = useSettingsStore((settings) => settings.audioRetentionDays);
  const transcriptRetentionDays = useSettingsStore((settings) => settings.transcriptRetentionDays);
  const dataRetentionEnabled = useSettingsStore((settings) => settings.dataRetentionEnabled);
  const enforcedAudioRetentionDays = usePolicyStore((policyState) =>
    effectiveAudioRetentionDays(policyState, audioRetentionDays)
  );
  const enforcedDataRetentionEnabled = usePolicyStore((policyState) =>
    effectiveLocalHistoryEnabled(policyState, dataRetentionEnabled)
  );
  const localHistoryPolicyResolved = usePolicyStore(isLocalHistoryPolicyResolved);
  useEffect(() => {
    window.electronAPI?.syncRetentionSettings?.({
      audioRetentionDays: enforcedAudioRetentionDays,
      transcriptRetentionDays,
      dataRetentionEnabled: enforcedDataRetentionEnabled,
      localHistoryPolicyResolved,
    });
  }, [
    enforcedAudioRetentionDays,
    transcriptRetentionDays,
    enforcedDataRetentionEnabled,
    localHistoryPolicyResolved,
  ]);

  // Sync startup pre-warming preferences to main process. Every window sends
  // policy-effective local models for all scopes before main decides to stop the shared server.
  const useLocalWhisper = useSettingsStore((settings) => settings.useLocalWhisper);
  const localTranscriptionProvider = useSettingsStore(
    (settings) => settings.localTranscriptionProvider
  );
  const whisperModel = useSettingsStore((settings) => settings.whisperModel);
  const parakeetModel = useSettingsStore((settings) => settings.parakeetModel);
  const cohereModel = useSettingsStore((settings) => settings.cohereModel);
  const preferredLanguage = useSettingsStore((settings) => settings.preferredLanguage);
  const keepLocalModelLoaded = useSettingsStore((settings) => settings.keepLocalModelLoaded);
  const policySnapshot = usePolicySnapshot();
  const localServerPrefs = useSettingsStore(
    useShallow((state) => selectLocalServerPrefs(state, policySnapshot))
  );
  const policySettled = isPolicySettled(policySnapshot);
  // A sign-out before the policy fetch starts leaves the policy idle, so only
  // the cleared account scope says this window's deferred sync can now apply.
  const [signOuts, setSignOuts] = useState(0);
  useEffect(
    () =>
      window.electronAPI?.onActiveAccountScopeChanged?.((scope) => {
        if (!scope) setSignOuts((count) => count + 1);
      }),
    []
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.electronAPI?.syncStartupPreferences) return;

    const model =
      localTranscriptionProvider === "nvidia"
        ? parakeetModel
        : localTranscriptionProvider === "cohere"
          ? cohereModel
          : whisperModel;
    window.electronAPI
      .syncStartupPreferences({
        useLocalWhisper,
        localTranscriptionProvider,
        model: model || undefined,
        language: preferredLanguage || undefined,
        ...localServerPrefs,
        keepLocalModelLoaded,
        policySettled,
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
    cohereModel,
    preferredLanguage,
    localServerPrefs,
    keepLocalModelLoaded,
    policySettled,
    signOuts,
  ]);

  return useMemo(
    () => ({ autoLearnCorrections, setAutoLearnCorrections: setAutoLearnCorrectionsRaw }),
    [autoLearnCorrections, setAutoLearnCorrectionsRaw]
  );
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const autoLearnCorrections = useSettingsLifecycle();
  return React.createElement(
    AutoLearnCorrectionsContext.Provider,
    { value: autoLearnCorrections },
    children
  );
}

export function useAutoLearnCorrections(): AutoLearnCorrectionsValue {
  const value = useContext(AutoLearnCorrectionsContext);
  if (!value) throw new Error("useAutoLearnCorrections must be used within SettingsProvider");
  return value;
}
