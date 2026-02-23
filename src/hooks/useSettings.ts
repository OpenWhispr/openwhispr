import React, { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { useDebouncedCallback } from "./useDebouncedCallback";
import { API_ENDPOINTS } from "../config/constants";
import logger from "../utils/logger";
import { ensureAgentNameInDictionary } from "../utils/agentName";
import i18n, { normalizeUiLanguage } from "../i18n";
import { hasStoredByokKey } from "../utils/byokDetection";
import type { LocalTranscriptionProvider } from "../types/electron";

let _ReasoningService: typeof import("../services/ReasoningService").default | null = null;
function getReasoningService() {
  if (!_ReasoningService) {
    _ReasoningService = require("../services/ReasoningService").default;
  }
  return _ReasoningService!;
}

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
  customDictionary: string[];
  assemblyAiStreaming: boolean;
  passAgentNameToWhisper: boolean;
}

export interface ReasoningSettings {
  useReasoningModel: boolean;
  reasoningModel: string;
  reasoningProvider: string;
  cloudReasoningBaseUrl?: string;
  cloudReasoningMode: string;
}

export interface HotkeySettings {
  dictationKey: string;
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
  customTranscriptionApiKey: string;
  customReasoningApiKey: string;
}

export interface PrivacySettings {
  cloudBackupEnabled: boolean;
  telemetryEnabled: boolean;
}

export interface ThemeSettings {
  theme: "light" | "dark" | "auto";
}

const LANGUAGE_MIGRATIONS: Record<string, string> = { zh: "zh-CN" };
let _migrated = false;
function migratePreferredLanguage() {
  if (_migrated) return;
  _migrated = true;
  const stored = localStorage.getItem("preferredLanguage");
  if (stored && LANGUAGE_MIGRATIONS[stored]) {
    localStorage.setItem("preferredLanguage", LANGUAGE_MIGRATIONS[stored]);
  }
}

function useSettingsInternal() {
  migratePreferredLanguage();

  const [useLocalWhisper, setUseLocalWhisper] = useLocalStorage("useLocalWhisper", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const [whisperModel, setWhisperModel] = useLocalStorage("whisperModel", "base", {
    serialize: String,
    deserialize: String,
  });

  const [localTranscriptionProvider, setLocalTranscriptionProvider] =
    useLocalStorage<LocalTranscriptionProvider>("localTranscriptionProvider", "whisper", {
      serialize: String,
      deserialize: (value) => (value === "nvidia" ? "nvidia" : "whisper"),
    });

  const [parakeetModel, setParakeetModel] = useLocalStorage("parakeetModel", "", {
    serialize: String,
    deserialize: String,
  });

  const [allowOpenAIFallback, setAllowOpenAIFallback] = useLocalStorage(
    "allowOpenAIFallback",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  const [allowLocalFallback, setAllowLocalFallback] = useLocalStorage("allowLocalFallback", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const [fallbackWhisperModel, setFallbackWhisperModel] = useLocalStorage(
    "fallbackWhisperModel",
    "base",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [preferredLanguage, setPreferredLanguage] = useLocalStorage("preferredLanguage", "auto", {
    serialize: String,
    deserialize: String,
  });

  const [uiLanguage, setUiLanguageLocal] = useLocalStorage("uiLanguage", "en", {
    serialize: String,
    deserialize: (value) => normalizeUiLanguage(value),
  });

  const setUiLanguage = useCallback(
    (language: string) => {
      setUiLanguageLocal(normalizeUiLanguage(language));
    },
    [setUiLanguageLocal]
  );

  const hasRunUiLanguageSync = useRef(false);
  const uiLanguageSyncReady = useRef(false);

  useEffect(() => {
    if (hasRunUiLanguageSync.current) return;
    hasRunUiLanguageSync.current = true;

    const sync = async () => {
      let resolved = normalizeUiLanguage(uiLanguage);

      if (typeof window !== "undefined" && window.electronAPI?.getUiLanguage) {
        const envLanguage = await window.electronAPI.getUiLanguage();
        resolved = normalizeUiLanguage(envLanguage || resolved);
      }

      if (resolved !== uiLanguage) {
        setUiLanguageLocal(resolved);
      }

      await i18n.changeLanguage(resolved);
      uiLanguageSyncReady.current = true;
    };

    sync().catch((err) => {
      logger.warn(
        "Failed to sync UI language on startup",
        { error: (err as Error).message },
        "settings"
      );
      uiLanguageSyncReady.current = true;
      void i18n.changeLanguage(normalizeUiLanguage(uiLanguage));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!uiLanguageSyncReady.current) return;

    const normalized = normalizeUiLanguage(uiLanguage);
    void i18n.changeLanguage(normalized);

    if (typeof window !== "undefined" && window.electronAPI?.setUiLanguage) {
      window.electronAPI.setUiLanguage(normalized).catch((err) => {
        logger.warn(
          "Failed to sync UI language to main process",
          { error: (err as Error).message },
          "settings"
        );
      });
    }
  }, [uiLanguage]);

  const [cloudTranscriptionProvider, setCloudTranscriptionProvider] = useLocalStorage(
    "cloudTranscriptionProvider",
    "openai",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cloudTranscriptionModel, setCloudTranscriptionModel] = useLocalStorage(
    "cloudTranscriptionModel",
    "gpt-4o-mini-transcribe",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cloudTranscriptionBaseUrl, setCloudTranscriptionBaseUrl] = useLocalStorage(
    "cloudTranscriptionBaseUrl",
    API_ENDPOINTS.TRANSCRIPTION_BASE,
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cloudReasoningBaseUrl, setCloudReasoningBaseUrl] = useLocalStorage(
    "cloudReasoningBaseUrl",
    API_ENDPOINTS.OPENAI_BASE,
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cloudTranscriptionMode, setCloudTranscriptionMode] = useLocalStorage(
    "cloudTranscriptionMode",
    hasStoredByokKey() ? "byok" : "openwhispr",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [cloudReasoningMode, setCloudReasoningMode] = useLocalStorage(
    "cloudReasoningMode",
    "openwhispr",
    {
      serialize: String,
      deserialize: String,
    }
  );

  // Custom dictionary for improving transcription of specific words
  const [customDictionary, setCustomDictionaryRaw] = useLocalStorage<string[]>(
    "customDictionary",
    [],
    {
      serialize: JSON.stringify,
      deserialize: (value) => {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      },
    }
  );

  // Assembly AI real-time streaming (enabled by default for signed-in users)
  const [assemblyAiStreaming, setAssemblyAiStreaming] = useLocalStorage(
    "assemblyAiStreaming",
    true,
    {
      serialize: String,
      deserialize: (value) => value !== "false", // Default to true unless explicitly disabled
    }
  );

  const [passAgentNameToWhisper, setPassAgentNameToWhisper] = useLocalStorage(
    "passAgentNameToWhisper",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  // Wrap setter to sync dictionary to SQLite
  const setCustomDictionary = useCallback(
    (words: string[]) => {
      setCustomDictionaryRaw(words);
      window.electronAPI?.setDictionary(words).catch((err) => {
        logger.warn(
          "Failed to sync dictionary to SQLite",
          { error: (err as Error).message },
          "settings"
        );
      });
    },
    [setCustomDictionaryRaw]
  );

  // One-time sync: reconcile localStorage ↔ SQLite on startup
  const hasRunDictionarySync = useRef(false);
  useEffect(() => {
    if (hasRunDictionarySync.current) return;
    hasRunDictionarySync.current = true;

    const syncDictionary = async () => {
      if (typeof window === "undefined" || !window.electronAPI?.getDictionary) return;
      try {
        const dbWords = await window.electronAPI.getDictionary();
        if (dbWords.length === 0 && customDictionary.length > 0) {
          // Seed SQLite from localStorage (first-time migration)
          await window.electronAPI.setDictionary(customDictionary);
        } else if (dbWords.length > 0 && customDictionary.length === 0) {
          // Recover localStorage from SQLite (e.g. localStorage was cleared)
          setCustomDictionaryRaw(dbWords);
        }
      } catch (err) {
        logger.warn(
          "Failed to sync dictionary on startup",
          { error: (err as Error).message },
          "settings"
        );
      }
    };

    syncDictionary().then(() => {
      // Ensure agent name is in dictionary for existing users who set it before this feature
      ensureAgentNameInDictionary();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reasoning settings
  const [useReasoningModel, setUseReasoningModel] = useLocalStorage("useReasoningModel", true, {
    serialize: String,
    deserialize: (value) => value !== "false", // Default true
  });

  const [reasoningModel, setReasoningModel] = useLocalStorage("reasoningModel", "", {
    serialize: String,
    deserialize: String,
  });

  const [reasoningProvider, setReasoningProvider] = useLocalStorage("reasoningProvider", "openai", {
    serialize: String,
    deserialize: String,
  });

  // API keys - localStorage for UI, synced to Electron IPC for persistence
  const [openaiApiKey, setOpenaiApiKeyLocal] = useLocalStorage("openaiApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [anthropicApiKey, setAnthropicApiKeyLocal] = useLocalStorage("anthropicApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [geminiApiKey, setGeminiApiKeyLocal] = useLocalStorage("geminiApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [groqApiKey, setGroqApiKeyLocal] = useLocalStorage("groqApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  const [mistralApiKey, setMistralApiKeyLocal] = useLocalStorage("mistralApiKey", "", {
    serialize: String,
    deserialize: String,
  });

  // Theme setting
  const [theme, setTheme] = useLocalStorage<"light" | "dark" | "auto">("theme", "auto", {
    serialize: String,
    deserialize: (value) => {
      if (["light", "dark", "auto"].includes(value)) return value as "light" | "dark" | "auto";
      return "auto";
    },
  });

  // Privacy settings — both default to OFF
  const [cloudBackupEnabled, setCloudBackupEnabled] = useLocalStorage("cloudBackupEnabled", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  const [telemetryEnabled, setTelemetryEnabled] = useLocalStorage("telemetryEnabled", false, {
    serialize: String,
    deserialize: (value) => value === "true",
  });

  // Custom endpoint API keys - synced to .env like other keys
  const [customTranscriptionApiKey, setCustomTranscriptionApiKeyLocal] = useLocalStorage(
    "customTranscriptionApiKey",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );

  const [customReasoningApiKey, setCustomReasoningApiKeyLocal] = useLocalStorage(
    "customReasoningApiKey",
    "",
    {
      serialize: String,
      deserialize: String,
    }
  );

  // Sync API keys from main process on first mount (if localStorage was cleared)
  const hasRunApiKeySync = useRef(false);
  useEffect(() => {
    if (hasRunApiKeySync.current) return;
    hasRunApiKeySync.current = true;

    const syncKeys = async () => {
      if (typeof window === "undefined" || !window.electronAPI) return;

      // Only sync keys that are missing from localStorage
      if (!openaiApiKey) {
        const envKey = await window.electronAPI.getOpenAIKey?.();
        if (envKey) setOpenaiApiKeyLocal(envKey);
      }
      if (!anthropicApiKey) {
        const envKey = await window.electronAPI.getAnthropicKey?.();
        if (envKey) setAnthropicApiKeyLocal(envKey);
      }
      if (!geminiApiKey) {
        const envKey = await window.electronAPI.getGeminiKey?.();
        if (envKey) setGeminiApiKeyLocal(envKey);
      }
      if (!groqApiKey) {
        const envKey = await window.electronAPI.getGroqKey?.();
        if (envKey) setGroqApiKeyLocal(envKey);
      }
      if (!mistralApiKey) {
        const envKey = await window.electronAPI.getMistralKey?.();
        if (envKey) setMistralApiKeyLocal(envKey);
      }
      if (!customTranscriptionApiKey) {
        const envKey = await window.electronAPI.getCustomTranscriptionKey?.();
        if (envKey) setCustomTranscriptionApiKeyLocal(envKey);
      }
      if (!customReasoningApiKey) {
        const envKey = await window.electronAPI.getCustomReasoningKey?.();
        if (envKey) setCustomReasoningApiKeyLocal(envKey);
      }
    };

    syncKeys().catch((err) => {
      logger.warn(
        "Failed to sync API keys on startup",
        { error: (err as Error).message },
        "settings"
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debouncedPersistToEnv = useDebouncedCallback(() => {
    if (typeof window !== "undefined" && window.electronAPI?.saveAllKeysToEnv) {
      window.electronAPI.saveAllKeysToEnv().catch((err) => {
        logger.warn(
          "Failed to persist API keys to .env",
          { error: (err as Error).message },
          "settings"
        );
      });
    }
  }, 1000);

  const invalidateApiKeyCaches = useCallback(
    (provider?: "openai" | "anthropic" | "gemini" | "groq" | "mistral" | "custom") => {
      if (provider) {
        getReasoningService().clearApiKeyCache(provider);
      }
      window.dispatchEvent(new Event("api-key-changed"));
      debouncedPersistToEnv();
    },
    [debouncedPersistToEnv]
  );

  const setOpenaiApiKey = useCallback(
    (key: string) => {
      setOpenaiApiKeyLocal(key);
      window.electronAPI?.saveOpenAIKey?.(key);
      invalidateApiKeyCaches("openai");
    },
    [setOpenaiApiKeyLocal, invalidateApiKeyCaches]
  );

  const setAnthropicApiKey = useCallback(
    (key: string) => {
      setAnthropicApiKeyLocal(key);
      window.electronAPI?.saveAnthropicKey?.(key);
      invalidateApiKeyCaches("anthropic");
    },
    [setAnthropicApiKeyLocal, invalidateApiKeyCaches]
  );

  const setGeminiApiKey = useCallback(
    (key: string) => {
      setGeminiApiKeyLocal(key);
      window.electronAPI?.saveGeminiKey?.(key);
      invalidateApiKeyCaches("gemini");
    },
    [setGeminiApiKeyLocal, invalidateApiKeyCaches]
  );

  const setGroqApiKey = useCallback(
    (key: string) => {
      setGroqApiKeyLocal(key);
      window.electronAPI?.saveGroqKey?.(key);
      invalidateApiKeyCaches("groq");
    },
    [setGroqApiKeyLocal, invalidateApiKeyCaches]
  );

  const setMistralApiKey = useCallback(
    (key: string) => {
      setMistralApiKeyLocal(key);
      window.electronAPI?.saveMistralKey?.(key);
      invalidateApiKeyCaches("mistral");
    },
    [setMistralApiKeyLocal, invalidateApiKeyCaches]
  );

  const setCustomTranscriptionApiKey = useCallback(
    (key: string) => {
      setCustomTranscriptionApiKeyLocal(key);
      window.electronAPI?.saveCustomTranscriptionKey?.(key);
      invalidateApiKeyCaches();
    },
    [setCustomTranscriptionApiKeyLocal, invalidateApiKeyCaches]
  );

  const setCustomReasoningApiKey = useCallback(
    (key: string) => {
      setCustomReasoningApiKeyLocal(key);
      window.electronAPI?.saveCustomReasoningKey?.(key);
      invalidateApiKeyCaches("custom");
    },
    [setCustomReasoningApiKeyLocal, invalidateApiKeyCaches]
  );

  const [dictationKey, setDictationKeyLocal] = useLocalStorage("dictationKey", "", {
    serialize: String,
    deserialize: String,
  });

  const setDictationKey = useCallback(
    (key: string) => {
      setDictationKeyLocal(key);
      if (typeof window !== "undefined" && window.electronAPI?.notifyHotkeyChanged) {
        window.electronAPI.notifyHotkeyChanged(key);
      }
      if (typeof window !== "undefined" && window.electronAPI?.saveDictationKey) {
        window.electronAPI.saveDictationKey(key);
      }
    },
    [setDictationKeyLocal]
  );

  const [activationMode, setActivationModeLocal] = useLocalStorage<"tap" | "push">(
    "activationMode",
    "tap",
    {
      serialize: String,
      deserialize: (value) => (value === "push" ? "push" : "tap"),
    }
  );

  const setActivationMode = useCallback(
    (mode: "tap" | "push") => {
      setActivationModeLocal(mode);
      if (typeof window !== "undefined" && window.electronAPI?.notifyActivationModeChanged) {
        window.electronAPI.notifyActivationModeChanged(mode);
      }
    },
    [setActivationModeLocal]
  );

  // Sync activation mode from main process on first mount (handles localStorage cleared)
  const hasRunActivationModeSync = useRef(false);
  useEffect(() => {
    if (hasRunActivationModeSync.current) return;
    hasRunActivationModeSync.current = true;

    const sync = async () => {
      if (!window.electronAPI?.getActivationMode) return;
      const envMode = await window.electronAPI.getActivationMode();
      if (envMode && envMode !== activationMode) {
        setActivationModeLocal(envMode);
      }
    };
    sync().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync dictation key from main process on first mount (handles localStorage cleared)
  const hasRunDictationKeySync = useRef(false);
  useEffect(() => {
    if (hasRunDictationKeySync.current) return;
    hasRunDictationKeySync.current = true;

    const sync = async () => {
      if (!window.electronAPI?.getDictationKey) return;
      const envKey = await window.electronAPI.getDictationKey();
      if (envKey && envKey !== dictationKey) {
        setDictationKeyLocal(envKey);
      }
    };
    sync().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [audioCuesEnabled, setAudioCuesEnabled] = useLocalStorage("audioCuesEnabled", true, {
    serialize: String,
    deserialize: (value) => value !== "false",
  });

  // Floating icon auto-hide setting
  const [floatingIconAutoHide, setFloatingIconAutoHideLocal] = useLocalStorage(
    "floatingIconAutoHide",
    false,
    {
      serialize: String,
      deserialize: (value) => value === "true",
    }
  );

  const setFloatingIconAutoHide = useCallback(
    (enabled: boolean) => {
      setFloatingIconAutoHideLocal(enabled);
      if (typeof window !== "undefined" && window.electronAPI?.notifyFloatingIconAutoHideChanged) {
        window.electronAPI.notifyFloatingIconAutoHideChanged(enabled);
      }
    },
    [setFloatingIconAutoHideLocal]
  );

  // Microphone settings
  const [preferBuiltInMic, setPreferBuiltInMic] = useLocalStorage("preferBuiltInMic", true, {
    serialize: String,
    deserialize: (value) => value !== "false",
  });

  const [selectedMicDeviceId, setSelectedMicDeviceId] = useLocalStorage("selectedMicDeviceId", "", {
    serialize: String,
    deserialize: String,
  });

  // Sync startup pre-warming preferences to main process
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

  // Batch operations
  const updateTranscriptionSettings = useCallback(
    (settings: Partial<TranscriptionSettings>) => {
      if (settings.useLocalWhisper !== undefined) setUseLocalWhisper(settings.useLocalWhisper);
      if (settings.uiLanguage !== undefined) setUiLanguage(settings.uiLanguage);
      if (settings.whisperModel !== undefined) setWhisperModel(settings.whisperModel);
      if (settings.localTranscriptionProvider !== undefined)
        setLocalTranscriptionProvider(settings.localTranscriptionProvider);
      if (settings.parakeetModel !== undefined) setParakeetModel(settings.parakeetModel);
      if (settings.allowOpenAIFallback !== undefined)
        setAllowOpenAIFallback(settings.allowOpenAIFallback);
      if (settings.allowLocalFallback !== undefined)
        setAllowLocalFallback(settings.allowLocalFallback);
      if (settings.fallbackWhisperModel !== undefined)
        setFallbackWhisperModel(settings.fallbackWhisperModel);
      if (settings.preferredLanguage !== undefined)
        setPreferredLanguage(settings.preferredLanguage);
      if (settings.cloudTranscriptionProvider !== undefined)
        setCloudTranscriptionProvider(settings.cloudTranscriptionProvider);
      if (settings.cloudTranscriptionModel !== undefined)
        setCloudTranscriptionModel(settings.cloudTranscriptionModel);
      if (settings.cloudTranscriptionBaseUrl !== undefined)
        setCloudTranscriptionBaseUrl(settings.cloudTranscriptionBaseUrl);
      if (settings.customDictionary !== undefined) setCustomDictionary(settings.customDictionary);
      if (settings.passAgentNameToWhisper !== undefined)
        setPassAgentNameToWhisper(settings.passAgentNameToWhisper);
    },
    [
      setUseLocalWhisper,
      setUiLanguage,
      setWhisperModel,
      setLocalTranscriptionProvider,
      setParakeetModel,
      setAllowOpenAIFallback,
      setAllowLocalFallback,
      setFallbackWhisperModel,
      setPreferredLanguage,
      setCloudTranscriptionProvider,
      setCloudTranscriptionModel,
      setCloudTranscriptionBaseUrl,
      setCustomDictionary,
      setPassAgentNameToWhisper,
    ]
  );

  const updateReasoningSettings = useCallback(
    (settings: Partial<ReasoningSettings>) => {
      if (settings.useReasoningModel !== undefined)
        setUseReasoningModel(settings.useReasoningModel);
      if (settings.reasoningModel !== undefined) setReasoningModel(settings.reasoningModel);
      if (settings.reasoningProvider !== undefined)
        setReasoningProvider(settings.reasoningProvider);
      if (settings.cloudReasoningBaseUrl !== undefined)
        setCloudReasoningBaseUrl(settings.cloudReasoningBaseUrl);
      if (settings.cloudReasoningMode !== undefined)
        setCloudReasoningMode(settings.cloudReasoningMode);
    },
    [
      setUseReasoningModel,
      setReasoningModel,
      setReasoningProvider,
      setCloudReasoningBaseUrl,
      setCloudReasoningMode,
    ]
  );

  const updateApiKeys = useCallback(
    (keys: Partial<ApiKeySettings>) => {
      if (keys.openaiApiKey !== undefined) setOpenaiApiKey(keys.openaiApiKey);
      if (keys.anthropicApiKey !== undefined) setAnthropicApiKey(keys.anthropicApiKey);
      if (keys.geminiApiKey !== undefined) setGeminiApiKey(keys.geminiApiKey);
      if (keys.groqApiKey !== undefined) setGroqApiKey(keys.groqApiKey);
      if (keys.mistralApiKey !== undefined) setMistralApiKey(keys.mistralApiKey);
    },
    [setOpenaiApiKey, setAnthropicApiKey, setGeminiApiKey, setGroqApiKey, setMistralApiKey]
  );

  return {
    useLocalWhisper,
    whisperModel,
    uiLanguage,
    localTranscriptionProvider,
    parakeetModel,
    allowOpenAIFallback,
    allowLocalFallback,
    fallbackWhisperModel,
    preferredLanguage,
    cloudTranscriptionProvider,
    cloudTranscriptionModel,
    cloudTranscriptionBaseUrl,
    cloudReasoningBaseUrl,
    cloudTranscriptionMode,
    cloudReasoningMode,
    customDictionary,
    assemblyAiStreaming,
    passAgentNameToWhisper,
    setAssemblyAiStreaming,
    useReasoningModel,
    reasoningModel,
    reasoningProvider,
    openaiApiKey,
    anthropicApiKey,
    geminiApiKey,
    groqApiKey,
    mistralApiKey,
    dictationKey,
    theme,
    setUseLocalWhisper,
    setWhisperModel,
    setUiLanguage,
    setLocalTranscriptionProvider,
    setParakeetModel,
    setAllowOpenAIFallback,
    setAllowLocalFallback,
    setFallbackWhisperModel,
    setPreferredLanguage,
    setCloudTranscriptionProvider,
    setCloudTranscriptionModel,
    setCloudTranscriptionBaseUrl,
    setCloudReasoningBaseUrl,
    setCloudTranscriptionMode,
    setCloudReasoningMode,
    setCustomDictionary,
    setPassAgentNameToWhisper,
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
    setTheme,
    activationMode,
    setActivationMode,
    audioCuesEnabled,
    setAudioCuesEnabled,
    floatingIconAutoHide,
    setFloatingIconAutoHide,
    preferBuiltInMic,
    selectedMicDeviceId,
    setPreferBuiltInMic,
    setSelectedMicDeviceId,
    cloudBackupEnabled,
    setCloudBackupEnabled,
    telemetryEnabled,
    setTelemetryEnabled,
    updateTranscriptionSettings,
    updateReasoningSettings,
    updateApiKeys,
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
