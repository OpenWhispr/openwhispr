import { create } from "zustand";
import { API_ENDPOINTS } from "../config/constants";
import i18n, { normalizeUiLanguage } from "../i18n";
import { hasStoredByokKey } from "../utils/byokDetection";
import { ensureAgentNameInDictionary } from "../utils/agentName";
import { useStreamingProvidersStore } from "./streamingProvidersStore";
import logger from "../utils/logger";
import type { LocalTranscriptionProvider, InferenceMode, SelfHostedType } from "../types/electron";
import type { DictionaryReplacement } from "../utils/dictionaryReplacements";
import { normalizeDictionaryReplacements } from "../utils/dictionaryReplacements";
import type { GoogleCalendarAccount } from "../types/calendar";
import { PROMPT_KIND_LIST, type PromptKind } from "../config/prompts/registry";
import {
  INFERENCE_SCOPES,
  type InferenceScope,
  type InferenceScopeDefinition,
  type InferenceScopeStoreKeys,
} from "../config/inferenceScopes";
import type {
  TranscriptionSettings,
  CleanupSettings,
  HotkeySettings,
  MicrophoneSettings,
  ApiKeySettings,
  PrivacySettings,
  ThemeSettings,
  ChatAgentSettings,
} from "../hooks/useSettings";

let _ReasoningService: typeof import("../services/ReasoningService").default | null = null;

const isBrowser = typeof window !== "undefined";

function readString(key: string, fallback: string): string {
  if (!isBrowser) return fallback;
  return localStorage.getItem(key) ?? fallback;
}

function readBoolean(key: string, fallback: boolean): boolean {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  if (fallback === true) return stored !== "false";
  return stored === "true";
}

function readStringArray(key: string, fallback: string[]): string[] {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readJson<T>(key: string, fallback: T): T {
  if (!isBrowser) return fallback;
  const stored = localStorage.getItem(key);
  if (stored === null) return fallback;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return fallback;
  }
}

// One-time migration for legacy `meetingFollows{Transcription,Reasoning}` flags.
// When the flag was true (the default), meeting/note recordings inherited the
// main dictation/intelligence settings. We've removed the toggle; copy the
// effective values into the dedicated meeting fields so post-migration reads
// (which always go through meeting fields) preserve every existing user's
// behavior. After migration the flag stays at "false" as a marker so this
// never runs again. Safe to delete after a few releases.
const MEETING_TRANSCRIPTION_PAIRS: ReadonlyArray<[string, string]> = [
  ["useLocalWhisper", "meetingUseLocalWhisper"],
  ["whisperModel", "meetingWhisperModel"],
  ["localTranscriptionProvider", "meetingLocalTranscriptionProvider"],
  ["parakeetModel", "meetingParakeetModel"],
  ["cloudTranscriptionProvider", "meetingCloudTranscriptionProvider"],
  ["cloudTranscriptionModel", "meetingCloudTranscriptionModel"],
  ["cloudTranscriptionBaseUrl", "meetingCloudTranscriptionBaseUrl"],
  ["cloudTranscriptionMode", "meetingCloudTranscriptionMode"],
  ["transcriptionMode", "meetingTranscriptionMode"],
  ["remoteTranscriptionType", "meetingRemoteTranscriptionType"],
  ["remoteTranscriptionUrl", "meetingRemoteTranscriptionUrl"],
];
const MEETING_REASONING_PAIRS: ReadonlyArray<[string, string]> = [
  ["reasoningProvider", "meetingReasoningProvider"],
  ["reasoningModel", "meetingReasoningModel"],
  ["reasoningMode", "meetingReasoningMode"],
  ["cloudReasoningMode", "meetingCloudReasoningMode"],
  ["cloudReasoningBaseUrl", "meetingCloudReasoningBaseUrl"],
  ["remoteReasoningType", "meetingRemoteReasoningType"],
  ["remoteReasoningUrl", "meetingRemoteReasoningUrl"],
];

function migrateMeetingFollowFlags() {
  if (!isBrowser) return;
  for (const [flag, pairs] of [
    ["meetingFollowsTranscription", MEETING_TRANSCRIPTION_PAIRS],
    ["meetingFollowsReasoning", MEETING_REASONING_PAIRS],
  ] as const) {
    if (localStorage.getItem(flag) === "false") continue;
    for (const [src, dst] of pairs) {
      const v = localStorage.getItem(src);
      if (v !== null) localStorage.setItem(dst, v);
    }
    localStorage.setItem(flag, "false");
  }
}

migrateMeetingFollowFlags();

const BOOLEAN_SETTINGS = new Set([
  "useLocalWhisper",
  "allowOpenAIFallback",
  "allowLocalFallback",
  "assemblyAiStreaming",
  "useCleanupModel",
  "useDictationAgent",
  "preferBuiltInMic",
  "cloudBackupEnabled",
  "telemetryEnabled",
  "audioCuesEnabled",
  "pauseMediaOnDictation",
  "floatingIconAutoHide",
  "startMinimized",
  "meetingProcessDetection",
  "meetingAudioDetection",
  "speakerDiarizationEnabled",
  "isSignedIn",
  "autoPasteEnabled",
  "keepTranscriptionInClipboard",
  "dataRetentionEnabled",
  "noteFilesEnabled",
  "showTranscriptionPreview",
  "cleanupDisableThinking",
  "dictationAgentDisableThinking",
  "noteFormattingDisableThinking",
  "chatAgentDisableThinking",
]);

const ARRAY_SETTINGS = new Set(["customDictionary", "gcalAccounts"]);

const NUMERIC_SETTINGS = new Set(["audioRetentionDays"]);

const LANGUAGE_MIGRATIONS: Record<string, string> = { zh: "zh-CN" };

function migratePreferredLanguage() {
  if (!isBrowser) return;
  const stored = localStorage.getItem("preferredLanguage");
  if (stored && LANGUAGE_MIGRATIONS[stored]) {
    localStorage.setItem("preferredLanguage", LANGUAGE_MIGRATIONS[stored]);
  }
}

migratePreferredLanguage();

function migrateProviderSettings() {
  if (!isBrowser) return;
  if (localStorage.getItem("_providerSettingsMigrated") === "1") return;

  const cloudMode = localStorage.getItem("cloudTranscriptionMode");
  const useLocal = localStorage.getItem("useLocalWhisper") === "true";
  const provider = localStorage.getItem("cloudTranscriptionProvider");

  let transcriptionMode: InferenceMode = "openwhispr";
  if (useLocal) {
    transcriptionMode = "local";
  } else if (cloudMode === "byok") {
    transcriptionMode = provider === "custom" ? "self-hosted" : "providers";
  }
  localStorage.setItem("transcriptionMode", transcriptionMode);

  if (provider === "custom" && cloudMode === "byok") {
    localStorage.setItem("remoteTranscriptionType", "openai-compatible");
  }

  const reasoningMode = localStorage.getItem("cloudReasoningMode");
  const reasoningProvider = localStorage.getItem("reasoningProvider");
  let newReasoningMode: InferenceMode = "openwhispr";
  if (reasoningMode === "byok") {
    if (reasoningProvider === "custom") {
      newReasoningMode = "self-hosted";
    } else if (
      reasoningProvider === "bedrock" ||
      reasoningProvider === "azure" ||
      reasoningProvider === "vertex"
    ) {
      newReasoningMode = "enterprise";
    } else if (
      reasoningProvider === "qwen" ||
      reasoningProvider === "llama" ||
      reasoningProvider === "mistral" ||
      reasoningProvider === "openai-oss" ||
      reasoningProvider === "gemma"
    ) {
      newReasoningMode = "local";
    } else {
      newReasoningMode = "providers";
    }
  }
  localStorage.setItem("reasoningMode", newReasoningMode);

  if (reasoningProvider === "custom" && reasoningMode === "byok") {
    localStorage.setItem("remoteReasoningType", "openai-compatible");
  }

  localStorage.setItem("_providerSettingsMigrated", "1");
}

migrateProviderSettings();

function migrateAgentMode() {
  if (!isBrowser) return;
  if (localStorage.getItem("_agentModeMigrated") === "1") return;

  const cloudAgentMode = localStorage.getItem("cloudAgentMode");
  const agentProvider = localStorage.getItem("agentProvider");

  let agentInferenceMode: InferenceMode = "openwhispr";
  if (cloudAgentMode === "byok") {
    const localProviders = ["qwen", "llama", "mistral", "openai-oss", "gemma"];
    if (agentProvider === "custom") {
      agentInferenceMode = "self-hosted";
    } else if (
      agentProvider === "bedrock" ||
      agentProvider === "azure" ||
      agentProvider === "vertex"
    ) {
      agentInferenceMode = "enterprise";
    } else if (agentProvider && localProviders.includes(agentProvider)) {
      agentInferenceMode = "local";
    } else {
      agentInferenceMode = "providers";
    }
  }
  localStorage.setItem("agentInferenceMode", agentInferenceMode);

  localStorage.setItem("_agentModeMigrated", "1");
}

migrateAgentMode();

function migrateCustomPrompts() {
  if (!isBrowser) return;
  if (localStorage.getItem("_promptsMigrated") === "1") return;

  const legacyUnified = localStorage.getItem("customUnifiedPrompt");
  if (legacyUnified) {
    try {
      const parsed = JSON.parse(legacyUnified);
      if (typeof parsed === "string" && parsed.length > 0) {
        if (!localStorage.getItem("customPrompt.cleanup")) {
          localStorage.setItem("customPrompt.cleanup", parsed);
        }
        if (!localStorage.getItem("customPrompt.dictationAgent")) {
          localStorage.setItem("customPrompt.dictationAgent", parsed);
        }
      }
    } catch {}
    localStorage.removeItem("customUnifiedPrompt");
  }

  const legacyChat = localStorage.getItem("agentSystemPrompt");
  if (legacyChat && legacyChat.length > 0 && !localStorage.getItem("customPrompt.chatAgent")) {
    localStorage.setItem("customPrompt.chatAgent", legacyChat);
  }
  if (legacyChat !== null) localStorage.removeItem("agentSystemPrompt");

  localStorage.setItem("_promptsMigrated", "1");
}

migrateCustomPrompts();

// One-time migration of legacy LLM-scope localStorage keys. Safe to delete
// after a few releases.
const LLM_SCOPE_KEY_PAIRS: ReadonlyArray<[string, string]> = [
  ["reasoningModel", "cleanupModel"],
  ["reasoningProvider", "cleanupProvider"],
  ["reasoningMode", "cleanupMode"],
  ["useReasoningModel", "useCleanupModel"],
  ["cloudReasoningMode", "cleanupCloudMode"],
  ["cloudReasoningBaseUrl", "cleanupCloudBaseUrl"],
  ["customReasoningApiKey", "cleanupCustomApiKey"],
  ["remoteReasoningUrl", "cleanupRemoteUrl"],
  ["meetingReasoningMode", "noteFormattingMode"],
  ["meetingReasoningProvider", "noteFormattingProvider"],
  ["meetingReasoningModel", "noteFormattingModel"],
  ["meetingCloudReasoningMode", "noteFormattingCloudMode"],
  ["meetingCloudReasoningBaseUrl", "noteFormattingCloudBaseUrl"],
  ["meetingRemoteReasoningUrl", "noteFormattingRemoteUrl"],
  ["agentInferenceMode", "chatAgentMode"],
  ["agentProvider", "chatAgentProvider"],
  ["agentModel", "chatAgentModel"],
  ["cloudAgentMode", "chatAgentCloudMode"],
  ["remoteAgentUrl", "chatAgentRemoteUrl"],
  ["agentKey", "chatAgentKey"],
];

function migrateLLMScopeKeys() {
  if (!isBrowser) return;
  if (localStorage.getItem("_llmScopeKeysMigrated") === "1") return;

  for (const [oldKey, newKey] of LLM_SCOPE_KEY_PAIRS) {
    const value = localStorage.getItem(oldKey);
    if (value === null) continue;
    if (localStorage.getItem(newKey) === null) {
      localStorage.setItem(newKey, value);
    }
    localStorage.removeItem(oldKey);
  }

  localStorage.setItem("_llmScopeKeysMigrated", "1");
}

migrateLLMScopeKeys();

export interface SettingsState
  extends
    TranscriptionSettings,
    CleanupSettings,
    HotkeySettings,
    MicrophoneSettings,
    ApiKeySettings,
    PrivacySettings,
    ThemeSettings,
    ChatAgentSettings {
  isSignedIn: boolean;
  audioCuesEnabled: boolean;
  pauseMediaOnDictation: boolean;
  floatingIconAutoHide: boolean;
  startMinimized: boolean;
  gcalAccounts: GoogleCalendarAccount[];
  gcalConnected: boolean;
  gcalEmail: string;
  meetingProcessDetection: boolean;
  meetingAudioDetection: boolean;
  speakerDiarizationEnabled: boolean;
  panelStartPosition: "bottom-right" | "center" | "bottom-left";
  showTranscriptionPreview: boolean;
  autoPasteEnabled: boolean;
  keepTranscriptionInClipboard: boolean;
  noteFilesEnabled: boolean;
  noteFilesPath: string;
  customDictionaryReplacements: DictionaryReplacement[];

  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  cleanupMode: InferenceMode;
  cleanupRemoteUrl: string;

  meetingTranscriptionMode: InferenceMode;
  meetingUseLocalWhisper: boolean;
  meetingWhisperModel: string;
  meetingLocalTranscriptionProvider: LocalTranscriptionProvider;
  meetingParakeetModel: string;
  meetingCloudTranscriptionProvider: string;
  meetingCloudTranscriptionModel: string;
  meetingCloudTranscriptionBaseUrl: string;
  meetingCloudTranscriptionMode: string;
  meetingRemoteTranscriptionType: SelfHostedType;
  meetingRemoteTranscriptionUrl: string;

  noteFormattingMode: InferenceMode;
  noteFormattingProvider: string;
  noteFormattingModel: string;
  noteFormattingCloudMode: string;
  noteFormattingCloudBaseUrl: string;
  noteFormattingRemoteUrl: string;
  noteFormattingCustomApiKey: string;

  dictationAgentMode: InferenceMode;
  dictationAgentProvider: string;
  dictationAgentModel: string;
  dictationAgentCloudMode: string;
  dictationAgentCloudBaseUrl: string;
  dictationAgentRemoteUrl: string;
  dictationAgentCustomApiKey: string;

  cleanupDisableThinking: boolean;
  dictationAgentDisableThinking: boolean;
  noteFormattingDisableThinking: boolean;
  chatAgentDisableThinking: boolean;

  customPrompts: Record<PromptKind, string>;
  setCustomPrompt: (kind: PromptKind, value: string) => void;

  setDictationAgentMode: (mode: InferenceMode) => void;
  setDictationAgentProvider: (value: string) => void;
  setDictationAgentModel: (value: string) => void;
  setDictationAgentCloudMode: (value: string) => void;
  setDictationAgentCloudBaseUrl: (value: string) => void;
  setDictationAgentRemoteUrl: (url: string) => void;
  setDictationAgentCustomApiKey: (key: string) => void;

  setTranscriptionMode: (mode: InferenceMode) => void;
  setRemoteTranscriptionType: (type: SelfHostedType) => void;
  setRemoteTranscriptionUrl: (url: string) => void;
  setCleanupMode: (mode: InferenceMode) => void;
  setCleanupRemoteUrl: (url: string) => void;

  setMeetingTranscriptionMode: (mode: InferenceMode) => void;
  setMeetingUseLocalWhisper: (value: boolean) => void;
  setMeetingWhisperModel: (value: string) => void;
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setMeetingParakeetModel: (value: string) => void;
  setMeetingCloudTranscriptionProvider: (value: string) => void;
  setMeetingCloudTranscriptionModel: (value: string) => void;
  setMeetingCloudTranscriptionBaseUrl: (value: string) => void;
  setMeetingCloudTranscriptionMode: (value: string) => void;
  setMeetingRemoteTranscriptionType: (type: SelfHostedType) => void;
  setMeetingRemoteTranscriptionUrl: (url: string) => void;

  setNoteFormattingMode: (mode: InferenceMode) => void;
  setNoteFormattingProvider: (value: string) => void;
  setNoteFormattingModel: (value: string) => void;
  setNoteFormattingCloudMode: (value: string) => void;
  setNoteFormattingCloudBaseUrl: (value: string) => void;
  setNoteFormattingRemoteUrl: (url: string) => void;
  setNoteFormattingCustomApiKey: (key: string) => void;

  setCleanupDisableThinking: (value: boolean) => void;
  setDictationAgentDisableThinking: (value: boolean) => void;
  setNoteFormattingDisableThinking: (value: boolean) => void;
  setChatAgentDisableThinking: (value: boolean) => void;

  setUseLocalWhisper: (value: boolean) => void;
  setWhisperModel: (value: string) => void;
  setLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => void;
  setParakeetModel: (value: string) => void;
  setAllowOpenAIFallback: (value: boolean) => void;
  setAllowLocalFallback: (value: boolean) => void;
  setFallbackWhisperModel: (value: string) => void;
  setPreferredLanguage: (value: string) => void;
  setCloudTranscriptionProvider: (value: string) => void;
  setCloudTranscriptionModel: (value: string) => void;
  setCloudTranscriptionBaseUrl: (value: string) => void;
  setCloudTranscriptionMode: (value: string) => void;
  setCleanupCloudMode: (value: string) => void;
  setCleanupCloudBaseUrl: (value: string) => void;
  setCustomDictionary: (words: string[]) => void;
  setCustomDictionaryReplacements: (replacements: DictionaryReplacement[]) => void;
  setAssemblyAiStreaming: (value: boolean) => void;
  setUseCleanupModel: (value: boolean) => void;
  setUseDictationAgent: (value: boolean) => void;
  setCleanupModel: (value: string) => void;
  setCleanupProvider: (value: string) => void;
  setUiLanguage: (language: string) => void;

  setOpenaiApiKey: (key: string) => void;
  setAnthropicApiKey: (key: string) => void;
  setGeminiApiKey: (key: string) => void;
  setGroqApiKey: (key: string) => void;
  setMistralApiKey: (key: string) => void;
  setCustomTranscriptionApiKey: (key: string) => void;
  setCleanupCustomApiKey: (key: string) => void;

  // Enterprise providers
  bedrockAuthMode: string;
  bedrockRegion: string;
  bedrockProfile: string;
  bedrockAccessKeyId: string;
  bedrockSecretAccessKey: string;
  bedrockSessionToken: string;
  azureEndpoint: string;
  azureApiKey: string;
  azureDeploymentName: string;
  azureApiVersion: string;
  vertexAuthMode: string;
  vertexProject: string;
  vertexLocation: string;
  vertexApiKey: string;
  setBedrockAuthMode: (value: string) => void;
  setBedrockRegion: (value: string) => void;
  setBedrockProfile: (value: string) => void;
  setBedrockAccessKeyId: (key: string) => void;
  setBedrockSecretAccessKey: (key: string) => void;
  setBedrockSessionToken: (key: string) => void;
  setAzureEndpoint: (value: string) => void;
  setAzureApiKey: (key: string) => void;
  setAzureDeploymentName: (value: string) => void;
  setAzureApiVersion: (value: string) => void;
  setVertexAuthMode: (value: string) => void;
  setVertexProject: (value: string) => void;
  setVertexLocation: (value: string) => void;
  setVertexApiKey: (key: string) => void;

  setDictationKey: (key: string) => void;
  setMeetingKey: (key: string) => void;
  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => void;
  setActivationMode: (mode: "tap" | "push") => void;

  setPreferBuiltInMic: (value: boolean) => void;
  setSelectedMicDeviceId: (value: string) => void;

  setTheme: (value: "light" | "dark" | "auto") => void;
  setCloudBackupEnabled: (value: boolean) => void;
  setTelemetryEnabled: (value: boolean) => void;
  setAudioRetentionDays: (days: number) => void;
  setDataRetentionEnabled: (value: boolean) => void;
  setAudioCuesEnabled: (value: boolean) => void;
  setPauseMediaOnDictation: (value: boolean) => void;
  setFloatingIconAutoHide: (enabled: boolean) => void;
  setStartMinimized: (enabled: boolean) => void;
  setGcalAccounts: (accounts: GoogleCalendarAccount[]) => void;
  setMeetingProcessDetection: (value: boolean) => void;
  setMeetingAudioDetection: (value: boolean) => void;
  setSpeakerDiarizationEnabled: (value: boolean) => void;
  setPanelStartPosition: (position: "bottom-right" | "center" | "bottom-left") => void;
  setShowTranscriptionPreview: (value: boolean) => void;
  setAutoPasteEnabled: (value: boolean) => void;
  setKeepTranscriptionInClipboard: (value: boolean) => void;
  setNoteFilesEnabled: (value: boolean) => void;
  setNoteFilesPath: (value: string) => void;
  setIsSignedIn: (value: boolean) => void;

  setChatAgentModel: (value: string) => void;
  setChatAgentProvider: (value: string) => void;
  setChatAgentKey: (key: string) => void;
  setChatAgentCloudMode: (value: string) => void;
  setChatAgentMode: (mode: InferenceMode) => void;
  setChatAgentCloudBaseUrl: (value: string) => void;
  setChatAgentRemoteUrl: (url: string) => void;
  setChatAgentCustomApiKey: (key: string) => void;

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => void;
  updateCleanupSettings: (settings: Partial<CleanupSettings>) => void;
  updateApiKeys: (keys: Partial<ApiKeySettings>) => void;
  updateChatAgentSettings: (settings: Partial<ChatAgentSettings>) => void;
}

function createStringSetter(key: string) {
  return (value: string) => {
    if (isBrowser) localStorage.setItem(key, value);
    useSettingsStore.setState({ [key]: value });
  };
}

function createBooleanSetter(key: string) {
  return (value: boolean) => {
    if (isBrowser) localStorage.setItem(key, String(value));
    useSettingsStore.setState({ [key]: value });
  };
}

let envPersistTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedPersistToEnv() {
  if (!isBrowser) return;
  if (envPersistTimer) clearTimeout(envPersistTimer);
  envPersistTimer = setTimeout(() => {
    window.electronAPI?.saveAllKeysToEnv?.().catch((err) => {
      logger.warn(
        "Failed to persist API keys to .env",
        { error: (err as Error).message },
        "settings"
      );
    });
  }, 1000);
}

const SECRET_IPC_SAVERS = {
  openai: "saveOpenAIKey",
  anthropic: "saveAnthropicKey",
  gemini: "saveGeminiKey",
  groq: "saveGroqKey",
  mistral: "saveMistralKey",
  customTranscription: "saveCustomTranscriptionKey",
  cleanupCustom: "saveCleanupCustomKey",
  bedrockAccessKeyId: "saveBedrockAccessKeyId",
  bedrockSecretAccessKey: "saveBedrockSecretAccessKey",
  bedrockSessionToken: "saveBedrockSessionToken",
  azureApiKey: "saveAzureApiKey",
  vertexApiKey: "saveVertexApiKey",
} as const;

type SecretProvider = keyof typeof SECRET_IPC_SAVERS;

const secretSaveTimers: Partial<Record<SecretProvider, ReturnType<typeof setTimeout>>> = {};
function debouncedSaveSecret(provider: SecretProvider, key: string) {
  if (!isBrowser) return;
  const timer = secretSaveTimers[provider];
  if (timer) clearTimeout(timer);
  secretSaveTimers[provider] = setTimeout(() => {
    const api = window.electronAPI;
    const save = api?.[SECRET_IPC_SAVERS[provider]] as
      | ((k: string) => Promise<unknown>)
      | undefined;
    save?.(key)?.catch((err) => {
      logger.warn(
        "Failed to persist secret",
        { provider, error: (err as Error).message },
        "settings"
      );
    });
  }, 250);
}

const STALE_SECRET_LOCALSTORAGE_KEYS = [
  "openaiApiKey",
  "anthropicApiKey",
  "geminiApiKey",
  "groqApiKey",
  "mistralApiKey",
  "customTranscriptionApiKey",
  "customReasoningApiKey",
  "cleanupCustomApiKey",
  "bedrockAccessKeyId",
  "bedrockSecretAccessKey",
  "bedrockSessionToken",
  "azureApiKey",
  "vertexApiKey",
] as const;

function invalidateApiKeyCaches(
  provider?: "openai" | "anthropic" | "gemini" | "groq" | "mistral" | "custom"
) {
  if (provider) {
    if (_ReasoningService) {
      _ReasoningService.clearApiKeyCache(provider);
    } else {
      import("../services/ReasoningService")
        .then((mod) => {
          _ReasoningService = mod.default;
          _ReasoningService.clearApiKeyCache(provider);
        })
        .catch(() => {});
    }
  }
  if (isBrowser) window.dispatchEvent(new Event("api-key-changed"));
  debouncedPersistToEnv();
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  uiLanguage: normalizeUiLanguage(isBrowser ? localStorage.getItem("uiLanguage") : null),
  useLocalWhisper: readBoolean("useLocalWhisper", false),
  whisperModel: readString("whisperModel", "base"),
  localTranscriptionProvider: (readString("localTranscriptionProvider", "whisper") === "nvidia"
    ? "nvidia"
    : "whisper") as LocalTranscriptionProvider,
  parakeetModel: readString("parakeetModel", ""),
  allowOpenAIFallback: readBoolean("allowOpenAIFallback", false),
  allowLocalFallback: readBoolean("allowLocalFallback", false),
  fallbackWhisperModel: readString("fallbackWhisperModel", "base"),
  preferredLanguage: readString("preferredLanguage", "auto"),
  cloudTranscriptionProvider: readString("cloudTranscriptionProvider", "openai"),
  cloudTranscriptionModel: readString("cloudTranscriptionModel", "gpt-4o-mini-transcribe"),
  cloudTranscriptionBaseUrl: readString(
    "cloudTranscriptionBaseUrl",
    API_ENDPOINTS.TRANSCRIPTION_BASE
  ),
  // Secrets aren't hydrated yet at construction; the BYOK default is set
  // post-hydration in initializeSettings.
  cloudTranscriptionMode: readString("cloudTranscriptionMode", "openwhispr"),
  cleanupCloudMode: readString("cleanupCloudMode", "openwhispr"),
  cleanupCloudBaseUrl: readString("cleanupCloudBaseUrl", API_ENDPOINTS.OPENAI_BASE),
  customDictionary: readStringArray("customDictionary", []),
  customDictionaryReplacements: normalizeDictionaryReplacements(
    readJson<DictionaryReplacement[]>("customDictionaryReplacements", [])
  ),
  assemblyAiStreaming: readBoolean("assemblyAiStreaming", true),

  useCleanupModel: readBoolean("useCleanupModel", true),
  useDictationAgent: readBoolean("useDictationAgent", true),
  cleanupModel: readString("cleanupModel", ""),
  cleanupProvider: readString("cleanupProvider", "openai"),

  // Secrets hydrate from main process in initializeSettings, never from localStorage.
  openaiApiKey: "",
  anthropicApiKey: "",
  geminiApiKey: "",
  groqApiKey: "",
  mistralApiKey: "",
  customTranscriptionApiKey: "",
  cleanupCustomApiKey: "",

  // Enterprise providers
  bedrockAuthMode: readString("bedrockAuthMode", "sso"),
  bedrockRegion: readString("bedrockRegion", "us-east-1"),
  bedrockProfile: readString("bedrockProfile", ""),
  bedrockAccessKeyId: "",
  bedrockSecretAccessKey: "",
  bedrockSessionToken: "",
  azureEndpoint: readString("azureEndpoint", ""),
  azureApiKey: "",
  azureDeploymentName: readString("azureDeploymentName", ""),
  azureApiVersion: readString("azureApiVersion", "2024-10-21"),
  vertexAuthMode: readString("vertexAuthMode", "adc"),
  vertexProject: readString("vertexProject", ""),
  vertexLocation: readString("vertexLocation", "us-central1"),
  vertexApiKey: "",

  dictationKey: readString("dictationKey", ""),
  meetingKey: readString("meetingKey", ""),
  meetingHotkeyLayoutMode: (readString("meetingHotkeyLayoutMode", "full-width") === "side-panel"
    ? "side-panel"
    : "full-width") as "side-panel" | "full-width",
  activationMode: (readString("activationMode", "tap") === "push" ? "push" : "tap") as
    | "tap"
    | "push",

  preferBuiltInMic: readBoolean("preferBuiltInMic", true),
  selectedMicDeviceId: readString("selectedMicDeviceId", ""),

  theme: (() => {
    const v = readString("theme", "auto");
    if (v === "light" || v === "dark" || v === "auto") return v;
    return "auto" as const;
  })(),
  cloudBackupEnabled: readBoolean("cloudBackupEnabled", false),
  telemetryEnabled: readBoolean("telemetryEnabled", false),
  audioRetentionDays: (() => {
    if (!isBrowser) return 30;
    const stored = localStorage.getItem("audioRetentionDays");
    if (stored === null) return 30;
    const parsed = parseInt(stored, 10);
    return isNaN(parsed) ? 30 : parsed;
  })(),
  dataRetentionEnabled: readBoolean("dataRetentionEnabled", true),
  audioCuesEnabled: readBoolean("audioCuesEnabled", true),
  pauseMediaOnDictation: readBoolean("pauseMediaOnDictation", false),
  floatingIconAutoHide: readBoolean("floatingIconAutoHide", false),
  startMinimized: readBoolean("startMinimized", false),
  ...(() => {
    let accounts: GoogleCalendarAccount[] = [];
    try {
      const parsed = JSON.parse(readString("gcalAccounts", "[]"));
      if (Array.isArray(parsed)) accounts = parsed;
    } catch {
      /* use empty default */
    }
    return {
      gcalAccounts: accounts,
      gcalConnected: accounts.length > 0,
      gcalEmail: accounts[0]?.email ?? "",
    };
  })(),
  meetingProcessDetection: readBoolean("meetingProcessDetection", true),
  meetingAudioDetection: readBoolean("meetingAudioDetection", true),
  speakerDiarizationEnabled: readBoolean("speakerDiarizationEnabled", true),
  panelStartPosition: (() => {
    const v = readString("panelStartPosition", "bottom-right");
    if (v === "bottom-right" || v === "center" || v === "bottom-left") return v;
    return "bottom-right" as const;
  })(),
  showTranscriptionPreview: readBoolean("showTranscriptionPreview", false),
  autoPasteEnabled: readBoolean("autoPasteEnabled", true),
  keepTranscriptionInClipboard: readBoolean("keepTranscriptionInClipboard", false),
  noteFilesEnabled: readBoolean("noteFilesEnabled", false),
  noteFilesPath: readString("noteFilesPath", ""),
  isSignedIn: readBoolean("isSignedIn", false),

  transcriptionMode: (() => {
    const v = readString("transcriptionMode", "openwhispr");
    if (v === "openwhispr" || v === "providers" || v === "local" || v === "self-hosted") return v;
    return "openwhispr" as InferenceMode;
  })(),
  remoteTranscriptionType: (() => {
    const v = readString("remoteTranscriptionType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  remoteTranscriptionUrl: readString("remoteTranscriptionUrl", ""),
  cleanupMode: (() => {
    const v = readString("cleanupMode", "openwhispr");
    if (
      v === "openwhispr" ||
      v === "providers" ||
      v === "local" ||
      v === "self-hosted" ||
      v === "enterprise"
    )
      return v;
    return "openwhispr" as InferenceMode;
  })(),
  cleanupRemoteUrl: readString("cleanupRemoteUrl", ""),

  meetingTranscriptionMode: (() => {
    const v = readString("meetingTranscriptionMode", "openwhispr");
    if (v === "openwhispr" || v === "providers" || v === "local" || v === "self-hosted") return v;
    return "openwhispr" as InferenceMode;
  })(),
  meetingUseLocalWhisper: readBoolean("meetingUseLocalWhisper", false),
  meetingWhisperModel: readString("meetingWhisperModel", ""),
  meetingLocalTranscriptionProvider: (readString("meetingLocalTranscriptionProvider", "whisper") ===
  "nvidia"
    ? "nvidia"
    : "whisper") as LocalTranscriptionProvider,
  meetingParakeetModel: readString("meetingParakeetModel", ""),
  meetingCloudTranscriptionProvider: readString("meetingCloudTranscriptionProvider", ""),
  meetingCloudTranscriptionModel: readString("meetingCloudTranscriptionModel", ""),
  meetingCloudTranscriptionBaseUrl: readString("meetingCloudTranscriptionBaseUrl", ""),
  meetingCloudTranscriptionMode: readString("meetingCloudTranscriptionMode", ""),
  meetingRemoteTranscriptionType: (() => {
    const v = readString("meetingRemoteTranscriptionType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  meetingRemoteTranscriptionUrl: readString("meetingRemoteTranscriptionUrl", ""),

  noteFormattingMode: (() => {
    const v = readString("noteFormattingMode", "openwhispr");
    if (
      v === "openwhispr" ||
      v === "providers" ||
      v === "local" ||
      v === "self-hosted" ||
      v === "enterprise"
    )
      return v;
    return "openwhispr" as InferenceMode;
  })(),
  noteFormattingProvider: readString("noteFormattingProvider", ""),
  noteFormattingModel: readString("noteFormattingModel", ""),
  noteFormattingCloudMode: readString("noteFormattingCloudMode", ""),
  noteFormattingCloudBaseUrl: readString("noteFormattingCloudBaseUrl", ""),
  noteFormattingRemoteUrl: readString("noteFormattingRemoteUrl", ""),
  noteFormattingCustomApiKey: readString("noteFormattingCustomApiKey", ""),

  setTranscriptionMode: createStringSetter("transcriptionMode") as (mode: InferenceMode) => void,
  setRemoteTranscriptionType: createStringSetter("remoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setRemoteTranscriptionUrl: createStringSetter("remoteTranscriptionUrl"),
  setCleanupMode: createStringSetter("cleanupMode") as (mode: InferenceMode) => void,
  setCleanupRemoteUrl: createStringSetter("cleanupRemoteUrl"),

  setMeetingTranscriptionMode: createStringSetter("meetingTranscriptionMode") as (
    mode: InferenceMode
  ) => void,
  setMeetingUseLocalWhisper: createBooleanSetter("meetingUseLocalWhisper"),
  setMeetingWhisperModel: createStringSetter("meetingWhisperModel"),
  setMeetingLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("meetingLocalTranscriptionProvider", value);
    useSettingsStore.setState({ meetingLocalTranscriptionProvider: value });
  },
  setMeetingParakeetModel: createStringSetter("meetingParakeetModel"),
  setMeetingCloudTranscriptionProvider: createStringSetter("meetingCloudTranscriptionProvider"),
  setMeetingCloudTranscriptionModel: createStringSetter("meetingCloudTranscriptionModel"),
  setMeetingCloudTranscriptionBaseUrl: createStringSetter("meetingCloudTranscriptionBaseUrl"),
  setMeetingCloudTranscriptionMode: createStringSetter("meetingCloudTranscriptionMode"),
  setMeetingRemoteTranscriptionType: createStringSetter("meetingRemoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setMeetingRemoteTranscriptionUrl: createStringSetter("meetingRemoteTranscriptionUrl"),

  setNoteFormattingMode: createStringSetter("noteFormattingMode") as (mode: InferenceMode) => void,
  setNoteFormattingProvider: createStringSetter("noteFormattingProvider"),
  setNoteFormattingModel: createStringSetter("noteFormattingModel"),
  setNoteFormattingCloudMode: createStringSetter("noteFormattingCloudMode"),
  setNoteFormattingCloudBaseUrl: createStringSetter("noteFormattingCloudBaseUrl"),
  setNoteFormattingRemoteUrl: createStringSetter("noteFormattingRemoteUrl"),
  setNoteFormattingCustomApiKey: createStringSetter("noteFormattingCustomApiKey"),

  chatAgentModel: readString("chatAgentModel", "openai/gpt-oss-120b"),
  chatAgentProvider: readString("chatAgentProvider", "groq"),
  chatAgentKey: readString("chatAgentKey", ""),
  chatAgentCloudMode: readString("chatAgentCloudMode", "openwhispr"),
  chatAgentMode: (() => {
    const v = readString("chatAgentMode", "openwhispr");
    if (
      v === "openwhispr" ||
      v === "providers" ||
      v === "local" ||
      v === "self-hosted" ||
      v === "enterprise"
    )
      return v;
    return "openwhispr" as InferenceMode;
  })(),
  chatAgentRemoteUrl: readString("chatAgentRemoteUrl", ""),
  chatAgentCloudBaseUrl: readString("chatAgentCloudBaseUrl", ""),
  chatAgentCustomApiKey: readString("chatAgentCustomApiKey", ""),

  dictationAgentMode: (() => {
    const v = readString("dictationAgentMode", "");
    if (
      v === "openwhispr" ||
      v === "providers" ||
      v === "local" ||
      v === "self-hosted" ||
      v === "enterprise"
    )
      return v;
    return "providers" as InferenceMode;
  })(),
  dictationAgentProvider: readString("dictationAgentProvider", ""),
  dictationAgentModel: readString("dictationAgentModel", ""),
  dictationAgentCloudMode: readString("dictationAgentCloudMode", ""),
  dictationAgentCloudBaseUrl: readString("dictationAgentCloudBaseUrl", ""),
  dictationAgentRemoteUrl: readString("dictationAgentRemoteUrl", ""),
  dictationAgentCustomApiKey: readString("dictationAgentCustomApiKey", ""),

  cleanupDisableThinking: readBoolean("cleanupDisableThinking", true),
  dictationAgentDisableThinking: readBoolean("dictationAgentDisableThinking", true),
  noteFormattingDisableThinking: readBoolean("noteFormattingDisableThinking", true),
  chatAgentDisableThinking: readBoolean("chatAgentDisableThinking", true),

  customPrompts: PROMPT_KIND_LIST.reduce(
    (acc, kind) => ({ ...acc, [kind]: readString(`customPrompt.${kind}`, "") }),
    {} as Record<PromptKind, string>
  ),
  setCustomPrompt: (kind, value) => {
    if (isBrowser) localStorage.setItem(`customPrompt.${kind}`, value);
    useSettingsStore.setState((s) => ({
      customPrompts: { ...s.customPrompts, [kind]: value },
    }));
  },

  setDictationAgentMode: createStringSetter("dictationAgentMode") as (mode: InferenceMode) => void,
  setDictationAgentProvider: createStringSetter("dictationAgentProvider"),
  setDictationAgentModel: createStringSetter("dictationAgentModel"),
  setDictationAgentCloudMode: createStringSetter("dictationAgentCloudMode"),
  setDictationAgentCloudBaseUrl: createStringSetter("dictationAgentCloudBaseUrl"),
  setDictationAgentRemoteUrl: createStringSetter("dictationAgentRemoteUrl"),
  setDictationAgentCustomApiKey: createStringSetter("dictationAgentCustomApiKey"),

  setCleanupDisableThinking: createBooleanSetter("cleanupDisableThinking"),
  setDictationAgentDisableThinking: createBooleanSetter("dictationAgentDisableThinking"),
  setNoteFormattingDisableThinking: createBooleanSetter("noteFormattingDisableThinking"),
  setChatAgentDisableThinking: createBooleanSetter("chatAgentDisableThinking"),

  setUseLocalWhisper: createBooleanSetter("useLocalWhisper"),
  setWhisperModel: createStringSetter("whisperModel"),
  setLocalTranscriptionProvider: (value: LocalTranscriptionProvider) => {
    if (isBrowser) localStorage.setItem("localTranscriptionProvider", value);
    set({ localTranscriptionProvider: value });
  },
  setParakeetModel: createStringSetter("parakeetModel"),
  setAllowOpenAIFallback: createBooleanSetter("allowOpenAIFallback"),
  setAllowLocalFallback: createBooleanSetter("allowLocalFallback"),
  setFallbackWhisperModel: createStringSetter("fallbackWhisperModel"),
  setPreferredLanguage: createStringSetter("preferredLanguage"),
  setCloudTranscriptionProvider: createStringSetter("cloudTranscriptionProvider"),
  setCloudTranscriptionModel: createStringSetter("cloudTranscriptionModel"),
  setCloudTranscriptionBaseUrl: createStringSetter("cloudTranscriptionBaseUrl"),
  setCloudTranscriptionMode: createStringSetter("cloudTranscriptionMode"),
  setCleanupCloudMode: createStringSetter("cleanupCloudMode"),
  setCleanupCloudBaseUrl: createStringSetter("cleanupCloudBaseUrl"),
  setAssemblyAiStreaming: createBooleanSetter("assemblyAiStreaming"),
  setUseCleanupModel: createBooleanSetter("useCleanupModel"),
  setUseDictationAgent: createBooleanSetter("useDictationAgent"),
  setCleanupProvider: createStringSetter("cleanupProvider"),
  setCleanupModel: createStringSetter("cleanupModel"),

  setCustomDictionary: (words: string[]) => {
    if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(words));
    set({ customDictionary: words });
    window.electronAPI?.setDictionary(words).catch((err) => {
      logger.warn(
        "Failed to sync dictionary to SQLite",
        { error: (err as Error).message },
        "settings"
      );
    });
  },
  setCustomDictionaryReplacements: (replacements: DictionaryReplacement[]) => {
    const normalized = normalizeDictionaryReplacements(replacements);
    if (isBrowser) localStorage.setItem("customDictionaryReplacements", JSON.stringify(normalized));
    set({ customDictionaryReplacements: normalized });
  },

  setUiLanguage: (language: string) => {
    const normalized = normalizeUiLanguage(language);
    if (isBrowser) localStorage.setItem("uiLanguage", normalized);
    set({ uiLanguage: normalized });
    void i18n.changeLanguage(normalized);
    if (isBrowser && window.electronAPI?.setUiLanguage) {
      window.electronAPI.setUiLanguage(normalized).catch((err) => {
        logger.warn(
          "Failed to sync UI language to main process",
          { error: (err as Error).message },
          "settings"
        );
      });
    }
  },

  setOpenaiApiKey: (key: string) => {
    set({ openaiApiKey: key });
    debouncedSaveSecret("openai", key);
    invalidateApiKeyCaches("openai");
  },
  setAnthropicApiKey: (key: string) => {
    set({ anthropicApiKey: key });
    debouncedSaveSecret("anthropic", key);
    invalidateApiKeyCaches("anthropic");
  },
  setGeminiApiKey: (key: string) => {
    set({ geminiApiKey: key });
    debouncedSaveSecret("gemini", key);
    invalidateApiKeyCaches("gemini");
  },
  setGroqApiKey: (key: string) => {
    set({ groqApiKey: key });
    debouncedSaveSecret("groq", key);
    invalidateApiKeyCaches("groq");
  },
  setMistralApiKey: (key: string) => {
    set({ mistralApiKey: key });
    debouncedSaveSecret("mistral", key);
    invalidateApiKeyCaches("mistral");
  },
  setCustomTranscriptionApiKey: (key: string) => {
    set({ customTranscriptionApiKey: key });
    debouncedSaveSecret("customTranscription", key);
    invalidateApiKeyCaches("custom");
  },
  setCleanupCustomApiKey: (key: string) => {
    set({ cleanupCustomApiKey: key });
    debouncedSaveSecret("cleanupCustom", key);
    invalidateApiKeyCaches("custom");
  },

  // Enterprise provider setters
  setBedrockAuthMode: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockAuthMode", value);
    set({ bedrockAuthMode: value });
  },
  setBedrockRegion: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockRegion", value);
    set({ bedrockRegion: value });
    window.electronAPI?.saveBedrockRegion?.(value);
    debouncedPersistToEnv();
  },
  setBedrockProfile: (value: string) => {
    if (isBrowser) localStorage.setItem("bedrockProfile", value);
    set({ bedrockProfile: value });
    window.electronAPI?.saveBedrockProfile?.(value);
    debouncedPersistToEnv();
  },
  setBedrockAccessKeyId: (key: string) => {
    set({ bedrockAccessKeyId: key });
    debouncedSaveSecret("bedrockAccessKeyId", key);
    debouncedPersistToEnv();
  },
  setBedrockSecretAccessKey: (key: string) => {
    set({ bedrockSecretAccessKey: key });
    debouncedSaveSecret("bedrockSecretAccessKey", key);
    debouncedPersistToEnv();
  },
  setBedrockSessionToken: (key: string) => {
    set({ bedrockSessionToken: key });
    debouncedSaveSecret("bedrockSessionToken", key);
    debouncedPersistToEnv();
  },
  setAzureEndpoint: (value: string) => {
    if (isBrowser) localStorage.setItem("azureEndpoint", value);
    set({ azureEndpoint: value });
    window.electronAPI?.saveAzureEndpoint?.(value);
    debouncedPersistToEnv();
  },
  setAzureApiKey: (key: string) => {
    set({ azureApiKey: key });
    debouncedSaveSecret("azureApiKey", key);
    debouncedPersistToEnv();
  },
  setAzureDeploymentName: (value: string) => {
    if (isBrowser) localStorage.setItem("azureDeploymentName", value);
    set({ azureDeploymentName: value });
    window.electronAPI?.saveAzureDeployment?.(value);
    debouncedPersistToEnv();
  },
  setAzureApiVersion: (value: string) => {
    if (isBrowser) localStorage.setItem("azureApiVersion", value);
    set({ azureApiVersion: value });
    window.electronAPI?.saveAzureApiVersion?.(value);
    debouncedPersistToEnv();
  },
  setVertexAuthMode: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexAuthMode", value);
    set({ vertexAuthMode: value });
  },
  setVertexProject: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexProject", value);
    set({ vertexProject: value });
    window.electronAPI?.saveVertexProject?.(value);
    debouncedPersistToEnv();
  },
  setVertexLocation: (value: string) => {
    if (isBrowser) localStorage.setItem("vertexLocation", value);
    set({ vertexLocation: value });
    window.electronAPI?.saveVertexLocation?.(value);
    debouncedPersistToEnv();
  },
  setVertexApiKey: (key: string) => {
    set({ vertexApiKey: key });
    debouncedSaveSecret("vertexApiKey", key);
    debouncedPersistToEnv();
  },

  setDictationKey: (key: string) => {
    if (isBrowser) localStorage.setItem("dictationKey", key);
    set({ dictationKey: key });
    if (isBrowser) {
      window.electronAPI?.notifyHotkeyChanged?.(key);
      window.electronAPI?.saveDictationKey?.(key);
    }
  },
  setMeetingKey: (key: string) => {
    if (isBrowser) localStorage.setItem("meetingKey", key);
    set({ meetingKey: key });
  },

  setMeetingHotkeyLayoutMode: (mode: "side-panel" | "full-width") => {
    if (isBrowser) localStorage.setItem("meetingHotkeyLayoutMode", mode);
    set({ meetingHotkeyLayoutMode: mode });
  },

  setActivationMode: (mode: "tap" | "push") => {
    if (isBrowser) localStorage.setItem("activationMode", mode);
    set({ activationMode: mode });
    if (isBrowser) {
      window.electronAPI?.notifyActivationModeChanged?.(mode);
    }
  },

  setPreferBuiltInMic: createBooleanSetter("preferBuiltInMic"),
  setSelectedMicDeviceId: createStringSetter("selectedMicDeviceId"),

  setTheme: (value: "light" | "dark" | "auto") => {
    if (isBrowser) localStorage.setItem("theme", value);
    set({ theme: value });
  },

  setCloudBackupEnabled: createBooleanSetter("cloudBackupEnabled"),
  setTelemetryEnabled: createBooleanSetter("telemetryEnabled"),
  setAudioRetentionDays: (days: number) => {
    if (isBrowser) localStorage.setItem("audioRetentionDays", String(days));
    set({ audioRetentionDays: days });
  },
  setDataRetentionEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("dataRetentionEnabled", String(value));
    set({ dataRetentionEnabled: value });
    logger.info(
      value
        ? "Data retention enabled — transcriptions and audio will be saved"
        : "Data retention disabled — transcriptions and audio will not be saved",
      {},
      "settings"
    );
  },
  setAudioCuesEnabled: createBooleanSetter("audioCuesEnabled"),
  setPauseMediaOnDictation: createBooleanSetter("pauseMediaOnDictation"),

  setFloatingIconAutoHide: (enabled: boolean) => {
    if (get().floatingIconAutoHide === enabled) return;
    if (isBrowser) localStorage.setItem("floatingIconAutoHide", String(enabled));
    set({ floatingIconAutoHide: enabled });
    if (isBrowser) {
      window.electronAPI?.notifyFloatingIconAutoHideChanged?.(enabled);
    }
  },

  setStartMinimized: (enabled: boolean) => {
    if (get().startMinimized === enabled) return;
    if (isBrowser) localStorage.setItem("startMinimized", String(enabled));
    set({ startMinimized: enabled });
    if (isBrowser) {
      window.electronAPI?.notifyStartMinimizedChanged?.(enabled);
    }
  },

  setGcalAccounts: (accounts: GoogleCalendarAccount[]) => {
    if (isBrowser) localStorage.setItem("gcalAccounts", JSON.stringify(accounts));
    useSettingsStore.setState({
      gcalAccounts: accounts,
      gcalConnected: accounts.length > 0,
      gcalEmail: accounts[0]?.email ?? "",
    });
  },
  setMeetingProcessDetection: createBooleanSetter("meetingProcessDetection"),
  setMeetingAudioDetection: createBooleanSetter("meetingAudioDetection"),
  setSpeakerDiarizationEnabled: (value: boolean) => {
    if (isBrowser) localStorage.setItem("speakerDiarizationEnabled", String(value));
    useSettingsStore.setState({ speakerDiarizationEnabled: value });
    if (isBrowser) {
      window.electronAPI?.setSpeakerDiarizationEnabled?.(value);
    }
  },
  setPanelStartPosition: (position: "bottom-right" | "center" | "bottom-left") => {
    if (get().panelStartPosition === position) return;
    if (isBrowser) localStorage.setItem("panelStartPosition", position);
    set({ panelStartPosition: position });
    if (isBrowser) {
      window.electronAPI?.notifyPanelStartPositionChanged?.(position);
    }
  },

  setShowTranscriptionPreview: createBooleanSetter("showTranscriptionPreview"),
  setAutoPasteEnabled: createBooleanSetter("autoPasteEnabled"),
  setKeepTranscriptionInClipboard: createBooleanSetter("keepTranscriptionInClipboard"),
  setNoteFilesEnabled: createBooleanSetter("noteFilesEnabled"),
  setNoteFilesPath: createStringSetter("noteFilesPath"),

  setIsSignedIn: (value: boolean) => {
    if (isBrowser) localStorage.setItem("isSignedIn", String(value));
    set({ isSignedIn: value });
  },

  setChatAgentModel: createStringSetter("chatAgentModel"),
  setChatAgentProvider: createStringSetter("chatAgentProvider"),
  setChatAgentKey: (key: string) => {
    if (!isBrowser) {
      useSettingsStore.setState({ chatAgentKey: key });
      return;
    }

    const updateAgentHotkey = window.electronAPI?.updateAgentHotkey;
    if (!updateAgentHotkey) {
      localStorage.setItem("chatAgentKey", key);
      useSettingsStore.setState({ chatAgentKey: key });
      window.electronAPI?.saveAgentKey?.(key);
      return;
    }

    const previousKey = get().chatAgentKey;

    void updateAgentHotkey(key)
      .then((result) => {
        if (!result?.success) {
          localStorage.setItem("chatAgentKey", previousKey);
          useSettingsStore.setState({ chatAgentKey: previousKey });
          logger.warn(
            "Failed to update chat agent hotkey",
            { hotkey: key, message: result?.message },
            "settings"
          );
          return;
        }

        localStorage.setItem("chatAgentKey", key);
        useSettingsStore.setState({ chatAgentKey: key });
      })
      .catch((error) => {
        logger.warn(
          "Failed to update chat agent hotkey",
          { hotkey: key, error: error instanceof Error ? error.message : String(error) },
          "settings"
        );
      });
  },
  setChatAgentCloudMode: createStringSetter("chatAgentCloudMode"),
  setChatAgentMode: createStringSetter("chatAgentMode") as (mode: InferenceMode) => void,
  setChatAgentCloudBaseUrl: createStringSetter("chatAgentCloudBaseUrl"),
  setChatAgentRemoteUrl: createStringSetter("chatAgentRemoteUrl"),
  setChatAgentCustomApiKey: createStringSetter("chatAgentCustomApiKey"),

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useLocalWhisper !== undefined) s.setUseLocalWhisper(settings.useLocalWhisper);
    if (settings.uiLanguage !== undefined) s.setUiLanguage(settings.uiLanguage);
    if (settings.whisperModel !== undefined) s.setWhisperModel(settings.whisperModel);
    if (settings.localTranscriptionProvider !== undefined)
      s.setLocalTranscriptionProvider(settings.localTranscriptionProvider);
    if (settings.parakeetModel !== undefined) s.setParakeetModel(settings.parakeetModel);
    if (settings.allowOpenAIFallback !== undefined)
      s.setAllowOpenAIFallback(settings.allowOpenAIFallback);
    if (settings.allowLocalFallback !== undefined)
      s.setAllowLocalFallback(settings.allowLocalFallback);
    if (settings.fallbackWhisperModel !== undefined)
      s.setFallbackWhisperModel(settings.fallbackWhisperModel);
    if (settings.preferredLanguage !== undefined)
      s.setPreferredLanguage(settings.preferredLanguage);
    if (settings.cloudTranscriptionProvider !== undefined)
      s.setCloudTranscriptionProvider(settings.cloudTranscriptionProvider);
    if (settings.cloudTranscriptionModel !== undefined)
      s.setCloudTranscriptionModel(settings.cloudTranscriptionModel);
    if (settings.cloudTranscriptionBaseUrl !== undefined)
      s.setCloudTranscriptionBaseUrl(settings.cloudTranscriptionBaseUrl);
    if (settings.cloudTranscriptionMode !== undefined)
      s.setCloudTranscriptionMode(settings.cloudTranscriptionMode);
    if (settings.customDictionary !== undefined) s.setCustomDictionary(settings.customDictionary);
    if (settings.assemblyAiStreaming !== undefined)
      s.setAssemblyAiStreaming(settings.assemblyAiStreaming);
    if (settings.showTranscriptionPreview !== undefined)
      s.setShowTranscriptionPreview(settings.showTranscriptionPreview);
  },

  updateCleanupSettings: (settings: Partial<CleanupSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useCleanupModel !== undefined) s.setUseCleanupModel(settings.useCleanupModel);
    if (settings.useDictationAgent !== undefined)
      s.setUseDictationAgent(settings.useDictationAgent);
    if (settings.cleanupModel !== undefined) s.setCleanupModel(settings.cleanupModel);
    if (settings.cleanupProvider !== undefined) s.setCleanupProvider(settings.cleanupProvider);
    if (settings.cleanupCloudBaseUrl !== undefined)
      s.setCleanupCloudBaseUrl(settings.cleanupCloudBaseUrl);
    if (settings.cleanupCloudMode !== undefined) s.setCleanupCloudMode(settings.cleanupCloudMode);
  },

  updateApiKeys: (keys: Partial<ApiKeySettings>) => {
    const s = useSettingsStore.getState();
    if (keys.openaiApiKey !== undefined) s.setOpenaiApiKey(keys.openaiApiKey);
    if (keys.anthropicApiKey !== undefined) s.setAnthropicApiKey(keys.anthropicApiKey);
    if (keys.geminiApiKey !== undefined) s.setGeminiApiKey(keys.geminiApiKey);
    if (keys.groqApiKey !== undefined) s.setGroqApiKey(keys.groqApiKey);
    if (keys.mistralApiKey !== undefined) s.setMistralApiKey(keys.mistralApiKey);
    if (keys.customTranscriptionApiKey !== undefined)
      s.setCustomTranscriptionApiKey(keys.customTranscriptionApiKey);
    if (keys.cleanupCustomApiKey !== undefined) s.setCleanupCustomApiKey(keys.cleanupCustomApiKey);
  },

  updateChatAgentSettings: (settings: Partial<ChatAgentSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.chatAgentModel !== undefined) s.setChatAgentModel(settings.chatAgentModel);
    if (settings.chatAgentProvider !== undefined)
      s.setChatAgentProvider(settings.chatAgentProvider);
    if (settings.chatAgentKey !== undefined) s.setChatAgentKey(settings.chatAgentKey);
    if (settings.chatAgentCloudMode !== undefined)
      s.setChatAgentCloudMode(settings.chatAgentCloudMode);
  },
}));

// --- Selectors (derived state, not stored) ---

export const selectIsCloudCleanupMode = (state: SettingsState) =>
  state.isSignedIn && state.cleanupMode === "openwhispr" && state.cleanupCloudMode === "openwhispr";

export const selectEffectiveCleanupProvider = (state: SettingsState) =>
  selectIsCloudCleanupMode(state) ? "openwhispr" : state.cleanupProvider;

export const selectIsCloudChatAgentMode = (state: SettingsState) =>
  state.isSignedIn &&
  state.chatAgentMode === "openwhispr" &&
  state.chatAgentCloudMode === "openwhispr";

export interface ResolvedMeetingTranscription {
  useLocalWhisper: boolean;
  whisperModel: string;
  localTranscriptionProvider: LocalTranscriptionProvider;
  parakeetModel: string;
  cloudTranscriptionProvider: string;
  cloudTranscriptionModel: string;
  cloudTranscriptionBaseUrl: string;
  cloudTranscriptionMode: string;
  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
}

export const selectResolvedMeetingTranscription = (
  state: SettingsState
): ResolvedMeetingTranscription => {
  const catalog = useStreamingProvidersStore.getState().providers;
  // TODO(1.8.0): Catalog has one cloud entry today (OpenAI Realtime).
  // When a second is added, resolve as `meetingCloudTranscriptionProvider || cloudTranscriptionProvider || catalog[0]?.id`, then validate against catalog.
  const cloudTranscriptionProvider = catalog?.[0]?.id ?? "";

  return {
    useLocalWhisper: state.meetingUseLocalWhisper,
    whisperModel: state.meetingWhisperModel || state.whisperModel,
    localTranscriptionProvider: state.meetingLocalTranscriptionProvider,
    parakeetModel: state.meetingParakeetModel || state.parakeetModel,
    cloudTranscriptionProvider,
    cloudTranscriptionModel: state.meetingCloudTranscriptionModel || state.cloudTranscriptionModel,
    cloudTranscriptionBaseUrl:
      state.meetingCloudTranscriptionBaseUrl || state.cloudTranscriptionBaseUrl || "",
    cloudTranscriptionMode: state.meetingCloudTranscriptionMode || state.cloudTranscriptionMode,
    transcriptionMode: state.meetingTranscriptionMode,
    remoteTranscriptionType: state.meetingRemoteTranscriptionType,
    remoteTranscriptionUrl: state.meetingRemoteTranscriptionUrl || state.remoteTranscriptionUrl,
  };
};

export interface ResolvedNoteFormatting {
  provider: string;
  model: string;
  mode: InferenceMode;
  cloudMode: string;
  cloudBaseUrl: string;
  remoteUrl: string;
}

export const selectResolvedNoteFormatting = (state: SettingsState): ResolvedNoteFormatting => {
  const cfg = selectResolvedLLMConfig(state, "noteFormatting");
  return {
    provider: cfg.provider,
    model: cfg.model,
    mode: cfg.mode,
    cloudMode: cfg.cloudMode || "",
    cloudBaseUrl: cfg.cloudBaseUrl || "",
    remoteUrl: cfg.remoteUrl || "",
  };
};

export interface ResolvedLLMConfig {
  scope: InferenceScope;
  mode: InferenceMode;
  provider: string;
  model: string;
  cloudMode?: string;
  cloudBaseUrl?: string;
  remoteUrl?: string;
  customApiKey?: string;
  disableThinking: boolean;
}

export const selectResolvedLLMConfig = (
  state: SettingsState,
  scope: InferenceScope
): ResolvedLLMConfig => {
  const def: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  const fallback = def.fallbackScope
    ? selectResolvedLLMConfig(state, def.fallbackScope as InferenceScope)
    : undefined;

  const read = (field: keyof InferenceScopeStoreKeys): string | undefined => {
    const key = def.storeKeys[field];
    if (!key) return undefined;
    return (state[key] as string | undefined) || undefined;
  };

  const disableThinkingKey = def.storeKeys.disableThinking;
  const disableThinking = disableThinkingKey ? (state[disableThinkingKey] as boolean) : true;

  return {
    scope,
    mode: state[def.storeKeys.mode] as InferenceMode,
    provider: read("provider") || fallback?.provider || "",
    model: read("model") || fallback?.model || "",
    cloudMode: read("cloudMode") || fallback?.cloudMode,
    cloudBaseUrl: read("cloudBaseUrl") || fallback?.cloudBaseUrl,
    remoteUrl: read("remoteUrl") || fallback?.remoteUrl,
    customApiKey: read("customApiKey"),
    disableThinking,
  };
};

export function setResolvedLLMConfig(
  scope: InferenceScope,
  patch: Partial<Omit<ResolvedLLMConfig, "scope">>
): void {
  const def: InferenceScopeDefinition = INFERENCE_SCOPES[scope];
  const updates: Partial<SettingsState> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const storeKey = def.storeKeys[field as keyof InferenceScopeStoreKeys];
    if (!storeKey) continue;
    if (isBrowser) {
      localStorage.setItem(
        storeKey as string,
        typeof value === "boolean" ? String(value) : (value as string)
      );
    }
    (updates as Record<string, unknown>)[storeKey as string] = value;
  }
  if (Object.keys(updates).length > 0) useSettingsStore.setState(updates);
}

export function isCloudChatAgentMode() {
  return selectIsCloudChatAgentMode(useSettingsStore.getState());
}

// --- Convenience getters for non-React code ---

export function getSettings() {
  return useSettingsStore.getState();
}

export function getEffectiveCleanupModel() {
  const state = useSettingsStore.getState();
  if (selectIsCloudCleanupMode(state)) {
    return "";
  }
  return state.cleanupModel;
}

export function isCloudCleanupMode() {
  return selectIsCloudCleanupMode(useSettingsStore.getState());
}

// --- Initialization ---

let hasInitialized = false;

export async function initializeSettings(): Promise<void> {
  if (hasInitialized) return;
  hasInitialized = true;

  if (!isBrowser) return;

  const state = useSettingsStore.getState();

  if (window.electronAPI) {
    try {
      const [
        openai,
        anthropic,
        gemini,
        groq,
        mistral,
        customTx,
        customRx,
        bedrockAccessKeyId,
        bedrockSecretAccessKey,
        bedrockSessionToken,
        azureApiKey,
        vertexApiKey,
      ] = await Promise.all([
        window.electronAPI.getOpenAIKey?.(),
        window.electronAPI.getAnthropicKey?.(),
        window.electronAPI.getGeminiKey?.(),
        window.electronAPI.getGroqKey?.(),
        window.electronAPI.getMistralKey?.(),
        window.electronAPI.getCustomTranscriptionKey?.(),
        window.electronAPI.getCleanupCustomKey?.(),
        window.electronAPI.getBedrockAccessKeyId?.(),
        window.electronAPI.getBedrockSecretAccessKey?.(),
        window.electronAPI.getBedrockSessionToken?.(),
        window.electronAPI.getAzureApiKey?.(),
        window.electronAPI.getVertexApiKey?.(),
      ]);

      useSettingsStore.setState({
        openaiApiKey: openai || "",
        anthropicApiKey: anthropic || "",
        geminiApiKey: gemini || "",
        groqApiKey: groq || "",
        mistralApiKey: mistral || "",
        customTranscriptionApiKey: customTx || "",
        cleanupCustomApiKey: customRx || "",
        bedrockAccessKeyId: bedrockAccessKeyId || "",
        bedrockSecretAccessKey: bedrockSecretAccessKey || "",
        bedrockSessionToken: bedrockSessionToken || "",
        azureApiKey: azureApiKey || "",
        vertexApiKey: vertexApiKey || "",
      });

      // hasStoredByokKey reads from Zustand, so this default must run after hydration.
      if (!localStorage.getItem("cloudTranscriptionMode") && hasStoredByokKey()) {
        useSettingsStore.setState({ cloudTranscriptionMode: "byok" });
      }

      for (const key of STALE_SECRET_LOCALSTORAGE_KEYS) {
        localStorage.removeItem(key);
      }
    } catch (err) {
      logger.warn(
        "Failed to hydrate secrets from main process",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync dictation key from main process.
    // localStorage holds the user's preferred hotkey. Only populate from .env
    // when localStorage is empty (fresh install / cleared data).
    try {
      if (!state.dictationKey) {
        const envKey = await window.electronAPI.getDictationKey?.();
        if (envKey) {
          createStringSetter("dictationKey")(envKey);
        }
      }
    } catch (err) {
      logger.warn(
        "Failed to sync dictation key on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Show the active hotkey in UI (zustand only, not localStorage).
    // May return constructor default during early startup; corrected by dictation-key-active event later.
    try {
      const activeKey = await window.electronAPI?.getActiveDictationKey?.();
      if (activeKey) {
        useSettingsStore.setState({ dictationKey: activeKey });
      }
    } catch (err) {
      logger.warn(
        "Failed to sync active dictation key on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync chat agent hotkey from main process
    try {
      const envKey = await window.electronAPI.getAgentKey?.();
      if (envKey && envKey !== state.chatAgentKey) {
        createStringSetter("chatAgentKey")(envKey);
      }
    } catch (err) {
      logger.warn(
        "Failed to sync chat agent hotkey on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      let envMode = await window.electronAPI.getActivationMode?.();
      if (envMode && envMode !== state.activationMode) {
        if (isBrowser) localStorage.setItem("activationMode", envMode);
        useSettingsStore.setState({ activationMode: envMode });
      }
    } catch (err) {
      logger.warn(
        "Failed to sync activation mode on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync UI language from main process
    try {
      const envLanguage = await window.electronAPI.getUiLanguage?.();
      const resolved = normalizeUiLanguage(envLanguage || state.uiLanguage);
      if (resolved !== state.uiLanguage) {
        if (isBrowser) localStorage.setItem("uiLanguage", resolved);
        useSettingsStore.setState({ uiLanguage: resolved });
      }
      await i18n.changeLanguage(resolved);
    } catch (err) {
      logger.warn(
        "Failed to sync UI language on startup",
        { error: (err as Error).message },
        "settings"
      );
      void i18n.changeLanguage(normalizeUiLanguage(state.uiLanguage));
    }

    const migratedLang = isBrowser ? localStorage.getItem("preferredLanguage") : null;
    if (migratedLang && migratedLang !== state.preferredLanguage) {
      useSettingsStore.setState({ preferredLanguage: migratedLang });
    }

    // Sync dictionary from SQLite <-> localStorage
    try {
      if (window.electronAPI.getDictionary) {
        const currentDictionary = useSettingsStore.getState().customDictionary;
        const dbWords = await window.electronAPI.getDictionary();
        if (dbWords.length === 0 && currentDictionary.length > 0) {
          await window.electronAPI.setDictionary(currentDictionary);
        } else if (dbWords.length > 0 && currentDictionary.length === 0) {
          if (isBrowser) localStorage.setItem("customDictionary", JSON.stringify(dbWords));
          useSettingsStore.setState({ customDictionary: dbWords });
        }
      }
    } catch (err) {
      logger.warn(
        "Failed to sync dictionary on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    // Sync meeting detection preferences to main process
    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.meetingDetectionSetPreferences?.({
        processDetection: currentState.meetingProcessDetection,
        audioDetection: currentState.meetingAudioDetection,
      });
    } catch (err) {
      logger.warn(
        "Failed to sync meeting detection preferences on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    try {
      const currentState = useSettingsStore.getState();
      await window.electronAPI.setSpeakerDiarizationEnabled?.(
        currentState.speakerDiarizationEnabled
      );
    } catch (err) {
      logger.warn(
        "Failed to sync speaker diarization preference on startup",
        { error: (err as Error).message },
        "settings"
      );
    }

    ensureAgentNameInDictionary();
  }

  // Sync Zustand store when another window writes to localStorage
  window.addEventListener("storage", (event) => {
    if (!event.key || event.storageArea !== localStorage || event.newValue === null) return;

    const { key, newValue } = event;

    if (key.startsWith("customPrompt.")) {
      const kind = key.slice("customPrompt.".length) as PromptKind;
      if (!PROMPT_KIND_LIST.includes(kind)) return;
      useSettingsStore.setState((s) => ({
        customPrompts: { ...s.customPrompts, [kind]: newValue },
      }));
      return;
    }

    const state = useSettingsStore.getState();
    if (!(key in state) || typeof (state as unknown as Record<string, unknown>)[key] === "function")
      return;

    let value: unknown;
    if (BOOLEAN_SETTINGS.has(key)) {
      value = newValue === "true";
    } else if (ARRAY_SETTINGS.has(key)) {
      try {
        const parsed = JSON.parse(newValue);
        value = Array.isArray(parsed) ? parsed : [];
      } catch {
        value = [];
      }
    } else if (NUMERIC_SETTINGS.has(key)) {
      const parsed = parseInt(newValue, 10);
      value = isNaN(parsed) ? 30 : parsed;
    } else {
      value = newValue;
    }

    useSettingsStore.setState({ [key]: value });

    if (key === "gcalAccounts" && Array.isArray(value)) {
      const accounts = value as GoogleCalendarAccount[];
      useSettingsStore.setState({
        gcalConnected: accounts.length > 0,
        gcalEmail: accounts[0]?.email ?? "",
      });
    }

    if (key === "uiLanguage" && typeof value === "string") {
      void i18n.changeLanguage(value);
    }
  });

  // Active hotkey updates from backend — zustand only, not localStorage.
  window.electronAPI?.onDictationKeyActive?.((key: string) => {
    useSettingsStore.setState({ dictationKey: key });
  });

  // Sync settings pushed from main process (e.g., hotkey changed in control panel)
  window.electronAPI?.onSettingUpdated?.((data: { key: string; value: unknown }) => {
    const state = useSettingsStore.getState();
    if (
      data.key in state &&
      typeof (state as unknown as Record<string, unknown>)[data.key] !== "function"
    ) {
      localStorage.setItem(
        data.key,
        typeof data.value === "string" ? data.value : JSON.stringify(data.value)
      );
      useSettingsStore.setState({ [data.key]: data.value });
    }
  });
}
