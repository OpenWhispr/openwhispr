import { create } from "zustand";
import { API_ENDPOINTS } from "../config/constants";
import i18n, { normalizeUiLanguage } from "../i18n";
import { hasStoredByokKey } from "../utils/byokDetection";
import { ensureAgentNameInDictionary } from "../utils/agentName";
import logger from "../utils/logger";
import type { LocalTranscriptionProvider } from "../types/electron";
import type {
  TranscriptionSettings,
  ReasoningSettings,
  HotkeySettings,
  MicrophoneSettings,
  ApiKeySettings,
  PrivacySettings,
  ThemeSettings,
} from "../hooks/useSettings";

let _ReasoningService: typeof import("../services/ReasoningService").default | null = null;
function getReasoningService() {
  if (!_ReasoningService) {
    _ReasoningService = require("../services/ReasoningService").default;
  }
  return _ReasoningService!;
}

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
  "floatingIconAutoHide",
  "isSignedIn",
]);

const ARRAY_SETTINGS = new Set(["customDictionary"]);

const LANGUAGE_MIGRATIONS: Record<string, string> = { zh: "zh-CN" };

function migratePreferredLanguage() {
  if (!isBrowser) return;
  const stored = localStorage.getItem("preferredLanguage");
  if (stored && LANGUAGE_MIGRATIONS[stored]) {
    localStorage.setItem("preferredLanguage", LANGUAGE_MIGRATIONS[stored]);
  }
}

migratePreferredLanguage();

export interface SettingsState
  extends
    TranscriptionSettings,
    ReasoningSettings,
    HotkeySettings,
    MicrophoneSettings,
    ApiKeySettings,
    PrivacySettings,
    ThemeSettings {
  isSignedIn: boolean;
  audioCuesEnabled: boolean;
  floatingIconAutoHide: boolean;

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

  setDictationKey: (key: string) => void;
  setActivationMode: (mode: "tap" | "push") => void;

  setPreferBuiltInMic: (value: boolean) => void;
  setSelectedMicDeviceId: (value: string) => void;

  setTheme: (value: "light" | "dark" | "auto") => void;
  setCloudBackupEnabled: (value: boolean) => void;
  setTelemetryEnabled: (value: boolean) => void;
  setAudioCuesEnabled: (value: boolean) => void;
  setFloatingIconAutoHide: (enabled: boolean) => void;
  setIsSignedIn: (value: boolean) => void;

  updateTranscriptionSettings: (settings: Partial<TranscriptionSettings>) => void;
  updateReasoningSettings: (settings: Partial<ReasoningSettings>) => void;
  updateApiKeys: (keys: Partial<ApiKeySettings>) => void;
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
    getReasoningService().clearApiKeyCache(provider);
  }
  if (isBrowser) window.dispatchEvent(new Event("api-key-changed"));
  debouncedPersistToEnv();
}

export const useSettingsStore = create<SettingsState>()((set) => ({
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

  dictationKey: readString("dictationKey", ""),
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
  audioCuesEnabled: readBoolean("audioCuesEnabled", true),
  floatingIconAutoHide: readBoolean("floatingIconAutoHide", false),
  isSignedIn: readBoolean("isSignedIn", false),

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
  setReasoningModel: createStringSetter("reasoningModel"),
  setReasoningProvider: createStringSetter("reasoningProvider"),

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
    invalidateApiKeyCaches();
  },
  setCustomReasoningApiKey: (key: string) => {
    if (isBrowser) localStorage.setItem("customReasoningApiKey", key);
    set({ customReasoningApiKey: key });
    window.electronAPI?.saveCustomReasoningKey?.(key);
    invalidateApiKeyCaches("custom");
  },

  setDictationKey: (key: string) => {
    if (isBrowser) localStorage.setItem("dictationKey", key);
    set({ dictationKey: key });
    if (isBrowser) {
      window.electronAPI?.notifyHotkeyChanged?.(key);
      window.electronAPI?.saveDictationKey?.(key);
    }
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
  setAudioCuesEnabled: createBooleanSetter("audioCuesEnabled"),

  setFloatingIconAutoHide: (enabled: boolean) => {
    if (isBrowser) localStorage.setItem("floatingIconAutoHide", String(enabled));
    set({ floatingIconAutoHide: enabled });
    if (isBrowser) {
      window.electronAPI?.notifyFloatingIconAutoHideChanged?.(enabled);
    }
  },

  setIsSignedIn: (value: boolean) => {
    if (isBrowser) localStorage.setItem("isSignedIn", String(value));
    set({ isSignedIn: value });
  },

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
}));

// --- Selectors (derived state, not stored) ---

export const selectIsCloudReasoningMode = (state: SettingsState) =>
  state.isSignedIn && state.cloudReasoningMode === "openwhispr";

export const selectEffectiveReasoningModel = (state: SettingsState) => state.reasoningModel;

export const selectEffectiveReasoningProvider = (state: SettingsState) =>
  selectIsCloudReasoningMode(state) ? "openwhispr" : state.reasoningProvider;

// --- Convenience getters for non-React code ---

export function getSettings() {
  return useSettingsStore.getState();
}

export function getEffectiveReasoningModel() {
  return selectEffectiveReasoningModel(useSettingsStore.getState());
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

    // Sync dictation key from main process
    try {
      const envKey = await window.electronAPI.getDictationKey?.();
      if (envKey && envKey !== state.dictationKey) {
        createStringSetter("dictationKey")(envKey);
      }
    } catch {
      // ignore
    }

    // Sync activation mode from main process
    try {
      const envMode = await window.electronAPI.getActivationMode?.();
      if (envMode && envMode !== state.activationMode) {
        if (isBrowser) localStorage.setItem("activationMode", envMode);
        useSettingsStore.setState({ activationMode: envMode });
      }
    } catch {
      // ignore
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

    // Migrate preferred language
    migratePreferredLanguage();
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
    } else {
      value = newValue;
    }

    useSettingsStore.setState({ [key]: value });

    if (key === "uiLanguage" && typeof value === "string") {
      void i18n.changeLanguage(value);
    }
  });
}
