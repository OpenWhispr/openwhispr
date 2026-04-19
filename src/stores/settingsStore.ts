import { create } from "zustand";
import { API_ENDPOINTS } from "../config/constants";
import i18n, { normalizeUiLanguage } from "../i18n";
import { hasStoredByokKey } from "../utils/byokDetection";
import { ensureAgentNameInDictionary } from "../utils/agentName";
import logger from "../utils/logger";
import type { LocalTranscriptionProvider, InferenceMode, SelfHostedType } from "../types/electron";
import type { GoogleCalendarAccount } from "../types/calendar";
import type {
  TranscriptionSettings,
  ReasoningSettings,
  HotkeySettings,
  MicrophoneSettings,
  ApiKeySettings,
  PrivacySettings,
  ThemeSettings,
  AgentModeSettings,
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

const BOOLEAN_SETTINGS = new Set([
  "useLocalWhisper",
  "allowOpenAIFallback",
  "allowLocalFallback",
  "assemblyAiStreaming",
  "useReasoningModel",
  "preferBuiltInMic",
  "cloudBackupEnabled",
  "telemetryEnabled",
  "audioCuesEnabled",
  "pauseMediaOnDictation",
  "floatingIconAutoHide",
  "startMinimized",
  "meetingProcessDetection",
  "meetingAudioDetection",
  "isSignedIn",
  "agentEnabled",
  "autoPasteEnabled",
  "keepTranscriptionInClipboard",
  "dataRetentionEnabled",
  "noteFilesEnabled",
  "showTranscriptionPreview",
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

export interface SettingsState
  extends
    TranscriptionSettings,
    ReasoningSettings,
    HotkeySettings,
    MicrophoneSettings,
    ApiKeySettings,
    PrivacySettings,
    ThemeSettings,
    AgentModeSettings {
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
  panelStartPosition: "bottom-right" | "center" | "bottom-left";
  showTranscriptionPreview: boolean;
  autoPasteEnabled: boolean;
  keepTranscriptionInClipboard: boolean;
  noteFilesEnabled: boolean;
  noteFilesPath: string;

  transcriptionMode: InferenceMode;
  remoteTranscriptionType: SelfHostedType;
  remoteTranscriptionUrl: string;
  reasoningMode: InferenceMode;
  remoteReasoningType: SelfHostedType;
  remoteReasoningUrl: string;

  setTranscriptionMode: (mode: InferenceMode) => void;
  setRemoteTranscriptionType: (type: SelfHostedType) => void;
  setRemoteTranscriptionUrl: (url: string) => void;
  setReasoningMode: (mode: InferenceMode) => void;
  setRemoteReasoningType: (type: SelfHostedType) => void;
  setRemoteReasoningUrl: (url: string) => void;

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
  setCloudReasoningMode: (value: string) => void;
  setCloudReasoningBaseUrl: (value: string) => void;
  setCustomDictionary: (words: string[]) => void;
  setAssemblyAiStreaming: (value: boolean) => void;
  setUseReasoningModel: (value: boolean) => void;
  setReasoningModel: (value: string) => void;
  setReasoningProvider: (value: string) => void;
  setUiLanguage: (language: string) => void;

  setOpenaiApiKey: (key: string) => void;
  setAnthropicApiKey: (key: string) => void;
  setGeminiApiKey: (key: string) => void;
  setGroqApiKey: (key: string) => void;
  setMistralApiKey: (key: string) => void;
  setCustomTranscriptionApiKey: (key: string) => void;
  setCustomReasoningApiKey: (key: string) => void;

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
  setPanelStartPosition: (position: "bottom-right" | "center" | "bottom-left") => void;
  setShowTranscriptionPreview: (value: boolean) => void;
  setAutoPasteEnabled: (value: boolean) => void;
  setKeepTranscriptionInClipboard: (value: boolean) => void;
  setNoteFilesEnabled: (value: boolean) => void;
  setNoteFilesPath: (value: string) => void;
  setIsSignedIn: (value: boolean) => void;

  setAgentModel: (value: string) => void;
  setAgentProvider: (value: string) => void;
  setAgentKey: (key: string) => void;
  setAgentSystemPrompt: (value: string) => void;
  setAgentEnabled: (value: boolean) => void;
  setCloudAgentMode: (value: string) => void;
  setAgentInferenceMode: (mode: InferenceMode) => void;
  setRemoteAgentUrl: (url: string) => void;

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => void;
  updateReasoningSettings: (settings: Partial<ReasoningSettings>) => void;
  updateApiKeys: (keys: Partial<ApiKeySettings>) => void;
  updateAgentModeSettings: (settings: Partial<AgentModeSettings>) => void;
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
  cloudTranscriptionMode: readString(
    "cloudTranscriptionMode",
    hasStoredByokKey() ? "byok" : "openwhispr"
  ),
  cloudReasoningMode: readString("cloudReasoningMode", "openwhispr"),
  cloudReasoningBaseUrl: readString("cloudReasoningBaseUrl", API_ENDPOINTS.OPENAI_BASE),
  customDictionary: readStringArray("customDictionary", []),
  assemblyAiStreaming: readBoolean("assemblyAiStreaming", true),

  useReasoningModel: readBoolean("useReasoningModel", true),
  reasoningModel: readString("reasoningModel", ""),
  reasoningProvider: readString("reasoningProvider", "openai"),

  openaiApiKey: readString("openaiApiKey", ""),
  anthropicApiKey: readString("anthropicApiKey", ""),
  geminiApiKey: readString("geminiApiKey", ""),
  groqApiKey: readString("groqApiKey", ""),
  mistralApiKey: readString("mistralApiKey", ""),
  customTranscriptionApiKey: readString("customTranscriptionApiKey", ""),
  customReasoningApiKey: readString("customReasoningApiKey", ""),

  // Enterprise providers
  bedrockAuthMode: readString("bedrockAuthMode", "sso"),
  bedrockRegion: readString("bedrockRegion", "us-east-1"),
  bedrockProfile: readString("bedrockProfile", ""),
  bedrockAccessKeyId: readString("bedrockAccessKeyId", ""),
  bedrockSecretAccessKey: readString("bedrockSecretAccessKey", ""),
  bedrockSessionToken: readString("bedrockSessionToken", ""),
  azureEndpoint: readString("azureEndpoint", ""),
  azureApiKey: readString("azureApiKey", ""),
  azureDeploymentName: readString("azureDeploymentName", ""),
  azureApiVersion: readString("azureApiVersion", "2024-10-21"),
  vertexAuthMode: readString("vertexAuthMode", "adc"),
  vertexProject: readString("vertexProject", ""),
  vertexLocation: readString("vertexLocation", "us-central1"),
  vertexApiKey: readString("vertexApiKey", ""),

  dictationKey: readString("dictationKey", ""),
  meetingKey: readString("meetingKey", ""),
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
  reasoningMode: (() => {
    const v = readString("reasoningMode", "openwhispr");
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
  remoteReasoningType: (() => {
    const v = readString("remoteReasoningType", "lan");
    return v === "openai-compatible" ? "openai-compatible" : ("lan" as SelfHostedType);
  })(),
  remoteReasoningUrl: readString("remoteReasoningUrl", ""),

  setTranscriptionMode: createStringSetter("transcriptionMode") as (mode: InferenceMode) => void,
  setRemoteTranscriptionType: createStringSetter("remoteTranscriptionType") as (
    type: SelfHostedType
  ) => void,
  setRemoteTranscriptionUrl: createStringSetter("remoteTranscriptionUrl"),
  setReasoningMode: createStringSetter("reasoningMode") as (mode: InferenceMode) => void,
  setRemoteReasoningType: createStringSetter("remoteReasoningType") as (
    type: SelfHostedType
  ) => void,
  setRemoteReasoningUrl: createStringSetter("remoteReasoningUrl"),

  agentModel: readString("agentModel", "openai/gpt-oss-120b"),
  agentProvider: readString("agentProvider", "groq"),
  agentKey: readString("agentKey", ""),
  agentSystemPrompt: readString("agentSystemPrompt", ""),
  agentEnabled: readBoolean("agentEnabled", true),
  cloudAgentMode: readString("cloudAgentMode", "openwhispr"),
  agentInferenceMode: (() => {
    const v = readString("agentInferenceMode", "openwhispr");
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
  remoteAgentUrl: readString("remoteAgentUrl", ""),

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
  setCloudReasoningMode: createStringSetter("cloudReasoningMode"),
  setCloudReasoningBaseUrl: createStringSetter("cloudReasoningBaseUrl"),
  setAssemblyAiStreaming: createBooleanSetter("assemblyAiStreaming"),
  setUseReasoningModel: createBooleanSetter("useReasoningModel"),
  setReasoningProvider: (value: string) => {
    if (isBrowser) localStorage.setItem("reasoningProvider", value);
    useSettingsStore.setState({ reasoningProvider: value });
  },
  setReasoningModel: (value: string) => {
    if (isBrowser) localStorage.setItem("reasoningModel", value);
    useSettingsStore.setState({ reasoningModel: value });
  },

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
    if (isBrowser) localStorage.setItem("openaiApiKey", key);
    set({ openaiApiKey: key });
    window.electronAPI?.saveOpenAIKey?.(key);
    invalidateApiKeyCaches("openai");
  },
  setAnthropicApiKey: (key: string) => {
    if (isBrowser) localStorage.setItem("anthropicApiKey", key);
    set({ anthropicApiKey: key });
    window.electronAPI?.saveAnthropicKey?.(key);
    invalidateApiKeyCaches("anthropic");
  },
  setGeminiApiKey: (key: string) => {
    if (isBrowser) localStorage.setItem("geminiApiKey", key);
    set({ geminiApiKey: key });
    window.electronAPI?.saveGeminiKey?.(key);
    invalidateApiKeyCaches("gemini");
  },
  setGroqApiKey: (key: string) => {
    if (isBrowser) localStorage.setItem("groqApiKey", key);
    set({ groqApiKey: key });
    window.electronAPI?.saveGroqKey?.(key);
    invalidateApiKeyCaches("groq");
  },
  setMistralApiKey: (key: string) => {
    if (isBrowser) localStorage.setItem("mistralApiKey", key);
    set({ mistralApiKey: key });
    window.electronAPI?.saveMistralKey?.(key);
    invalidateApiKeyCaches("mistral");
  },
  setCustomTranscriptionApiKey: (key: string) => {
    if (isBrowser) localStorage.setItem("customTranscriptionApiKey", key);
    set({ customTranscriptionApiKey: key });
    window.electronAPI?.saveCustomTranscriptionKey?.(key);
    invalidateApiKeyCaches("custom");
  },
  setCustomReasoningApiKey: (key: string) => {
    if (isBrowser) localStorage.setItem("customReasoningApiKey", key);
    set({ customReasoningApiKey: key });
    window.electronAPI?.saveCustomReasoningKey?.(key);
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
    if (isBrowser) localStorage.setItem("bedrockAccessKeyId", key);
    set({ bedrockAccessKeyId: key });
    window.electronAPI?.saveBedrockAccessKeyId?.(key);
    debouncedPersistToEnv();
  },
  setBedrockSecretAccessKey: (key: string) => {
    if (isBrowser) localStorage.setItem("bedrockSecretAccessKey", key);
    set({ bedrockSecretAccessKey: key });
    window.electronAPI?.saveBedrockSecretAccessKey?.(key);
    debouncedPersistToEnv();
  },
  setBedrockSessionToken: (key: string) => {
    if (isBrowser) localStorage.setItem("bedrockSessionToken", key);
    set({ bedrockSessionToken: key });
    window.electronAPI?.saveBedrockSessionToken?.(key);
    debouncedPersistToEnv();
  },
  setAzureEndpoint: (value: string) => {
    if (isBrowser) localStorage.setItem("azureEndpoint", value);
    set({ azureEndpoint: value });
    window.electronAPI?.saveAzureEndpoint?.(value);
    debouncedPersistToEnv();
  },
  setAzureApiKey: (key: string) => {
    if (isBrowser) localStorage.setItem("azureApiKey", key);
    set({ azureApiKey: key });
    window.electronAPI?.saveAzureApiKey?.(key);
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
    if (isBrowser) localStorage.setItem("vertexApiKey", key);
    set({ vertexApiKey: key });
    window.electronAPI?.saveVertexApiKey?.(key);
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

  setAgentModel: (value: string) => {
    if (isBrowser) localStorage.setItem("agentModel", value);
    useSettingsStore.setState({ agentModel: value });
  },
  setAgentProvider: (value: string) => {
    if (isBrowser) localStorage.setItem("agentProvider", value);
    useSettingsStore.setState({ agentProvider: value });
  },
  setAgentKey: (key: string) => {
    if (!isBrowser) {
      useSettingsStore.setState({ agentKey: key });
      return;
    }

    const updateAgentHotkey = window.electronAPI?.updateAgentHotkey;
    if (!updateAgentHotkey) {
      localStorage.setItem("agentKey", key);
      useSettingsStore.setState({ agentKey: key });
      window.electronAPI?.saveAgentKey?.(key);
      return;
    }

    const previousKey = get().agentKey;

    void updateAgentHotkey(key)
      .then((result) => {
        if (!result?.success) {
          localStorage.setItem("agentKey", previousKey);
          useSettingsStore.setState({ agentKey: previousKey });
          logger.warn(
            "Failed to update agent hotkey",
            { hotkey: key, message: result?.message },
            "settings"
          );
          return;
        }

        localStorage.setItem("agentKey", key);
        useSettingsStore.setState({ agentKey: key });
      })
      .catch((error) => {
        logger.warn(
          "Failed to update agent hotkey",
          { hotkey: key, error: error instanceof Error ? error.message : String(error) },
          "settings"
        );
      });
  },
  setAgentSystemPrompt: createStringSetter("agentSystemPrompt"),
  setAgentEnabled: createBooleanSetter("agentEnabled"),
  setCloudAgentMode: createStringSetter("cloudAgentMode"),
  setAgentInferenceMode: createStringSetter("agentInferenceMode") as (mode: InferenceMode) => void,
  setRemoteAgentUrl: createStringSetter("remoteAgentUrl"),

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

  updateReasoningSettings: (settings: Partial<ReasoningSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.useReasoningModel !== undefined)
      s.setUseReasoningModel(settings.useReasoningModel);
    if (settings.reasoningModel !== undefined) s.setReasoningModel(settings.reasoningModel);
    if (settings.reasoningProvider !== undefined)
      s.setReasoningProvider(settings.reasoningProvider);
    if (settings.cloudReasoningBaseUrl !== undefined)
      s.setCloudReasoningBaseUrl(settings.cloudReasoningBaseUrl);
    if (settings.cloudReasoningMode !== undefined)
      s.setCloudReasoningMode(settings.cloudReasoningMode);
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
    if (keys.customReasoningApiKey !== undefined)
      s.setCustomReasoningApiKey(keys.customReasoningApiKey);
  },

  updateAgentModeSettings: (settings: Partial<AgentModeSettings>) => {
    const s = useSettingsStore.getState();
    if (settings.agentModel !== undefined) s.setAgentModel(settings.agentModel);
    if (settings.agentProvider !== undefined) s.setAgentProvider(settings.agentProvider);
    if (settings.agentKey !== undefined) s.setAgentKey(settings.agentKey);
    if (settings.agentSystemPrompt !== undefined)
      s.setAgentSystemPrompt(settings.agentSystemPrompt);
    if (settings.agentEnabled !== undefined) s.setAgentEnabled(settings.agentEnabled);
    if (settings.cloudAgentMode !== undefined) s.setCloudAgentMode(settings.cloudAgentMode);
  },
}));

// --- Selectors (derived state, not stored) ---

export const selectIsCloudReasoningMode = (state: SettingsState) =>
  state.isSignedIn && state.cloudReasoningMode === "openwhispr";

export const selectEffectiveReasoningProvider = (state: SettingsState) =>
  selectIsCloudReasoningMode(state) ? "openwhispr" : state.reasoningProvider;

export const selectIsCloudAgentMode = (state: SettingsState) =>
  state.isSignedIn && state.cloudAgentMode === "openwhispr";

export function isCloudAgentMode() {
  return selectIsCloudAgentMode(useSettingsStore.getState());
}

// --- Convenience getters for non-React code ---

export function getSettings() {
  return useSettingsStore.getState();
}

export function getEffectiveReasoningModel() {
  const state = useSettingsStore.getState();
  if (selectIsCloudReasoningMode(state)) {
    return "";
  }
  return state.reasoningModel;
}

export function isCloudReasoningMode() {
  return selectIsCloudReasoningMode(useSettingsStore.getState());
}

// --- Initialization ---

let hasInitialized = false;

export async function initializeSettings(): Promise<void> {
  if (hasInitialized) return;
  hasInitialized = true;

  if (!isBrowser) return;

  const state = useSettingsStore.getState();

  // Sync API keys from main process (if localStorage is empty, read from .env via IPC)
  if (window.electronAPI) {
    try {
      if (!state.openaiApiKey) {
        const envKey = await window.electronAPI.getOpenAIKey?.();
        if (envKey) createStringSetter("openaiApiKey")(envKey);
      }
      if (!state.anthropicApiKey) {
        const envKey = await window.electronAPI.getAnthropicKey?.();
        if (envKey) createStringSetter("anthropicApiKey")(envKey);
      }
      if (!state.geminiApiKey) {
        const envKey = await window.electronAPI.getGeminiKey?.();
        if (envKey) createStringSetter("geminiApiKey")(envKey);
      }
      if (!state.groqApiKey) {
        const envKey = await window.electronAPI.getGroqKey?.();
        if (envKey) createStringSetter("groqApiKey")(envKey);
      }
      if (!state.mistralApiKey) {
        const envKey = await window.electronAPI.getMistralKey?.();
        if (envKey) createStringSetter("mistralApiKey")(envKey);
      }
      if (!state.customTranscriptionApiKey) {
        const envKey = await window.electronAPI.getCustomTranscriptionKey?.();
        if (envKey) createStringSetter("customTranscriptionApiKey")(envKey);
      }
      if (!state.customReasoningApiKey) {
        const envKey = await window.electronAPI.getCustomReasoningKey?.();
        if (envKey) createStringSetter("customReasoningApiKey")(envKey);
      }
    } catch (err) {
      logger.warn(
        "Failed to sync API keys on startup",
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

    // Sync agent key from main process
    try {
      const envKey = await window.electronAPI.getAgentKey?.();
      if (envKey && envKey !== state.agentKey) {
        createStringSetter("agentKey")(envKey);
      }
    } catch (err) {
      logger.warn(
        "Failed to sync agent key on startup",
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

    ensureAgentNameInDictionary();
  }

  // Sync Zustand store when another window writes to localStorage
  window.addEventListener("storage", (event) => {
    if (!event.key || event.storageArea !== localStorage || event.newValue === null) return;

    const { key, newValue } = event;
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
