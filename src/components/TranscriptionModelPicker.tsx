import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Download, Trash2, Cloud, Lock, X, Zap, Check } from "lucide-react";
import { ProviderIcon } from "./ui/ProviderIcon";
import { ProviderTabs } from "./ui/ProviderTabs";
import ModelCardList from "./ui/ModelCardList";
import { DownloadProgressBar } from "./ui/DownloadProgressBar";
import ApiKeyInput from "./ui/ApiKeyInput";
import { ConfirmDialog } from "./ui/dialog";
import { useDialogs } from "../hooks/useDialogs";
import { useModelDownload, type DownloadProgress } from "../hooks/useModelDownload";
import {
  getTranscriptionProviders,
  getStreamingTranscriptionProviders,
  TranscriptionProviderData,
  WHISPER_MODEL_INFO,
  PARAKEET_MODEL_INFO,
} from "../models/ModelRegistry";
import {
  MODEL_PICKER_COLORS,
  type ColorScheme,
  type ModelPickerStyles,
} from "../utils/modelPickerStyles";
import { useSettingsStore } from "../stores/settingsStore";
import { getRemoteProviderIcon } from "../utils/providerIcons";
import { createExternalLinkHandler } from "../utils/externalLinks";
import { API_ENDPOINTS, normalizeBaseUrl } from "../config/constants";
import { GetApiKeyLink } from "./ui/GetApiKeyLink";
import { getCachedPlatform } from "../utils/platform";
import type { CudaWhisperStatus } from "../types/electron";
import logger from "../utils/logger";

interface LocalModel {
  model: string;
  size_mb?: number;
  downloaded?: boolean;
}

interface LocalModelCardProps {
  modelId: string;
  name: string;
  description: string;
  size: string;
  actualSizeMb?: number;
  isSelected: boolean;
  isDownloaded: boolean;
  isDownloading: boolean;
  isCancelling: boolean;
  isInstalling: boolean;
  recommended?: boolean;
  provider: string;
  languageLabel?: string;
  onSelect: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onCancel: () => void;
  styles: ModelPickerStyles;
}

function LocalModelCard({
  modelId,
  name,
  description,
  size,
  actualSizeMb,
  isSelected,
  isDownloaded,
  isDownloading,
  isCancelling,
  isInstalling,
  recommended,
  provider,
  languageLabel,
  onSelect,
  onDelete,
  onDownload,
  onCancel,
  styles: cardStyles,
}: LocalModelCardProps) {
  const { t } = useTranslation();
  const handleClick = () => {
    if (isDownloaded && !isSelected) {
      onSelect();
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`relative w-full text-left overflow-hidden rounded-md border transition-colors duration-200 group ${
        isSelected ? cardStyles.modelCard.selected : cardStyles.modelCard.default
      } ${isDownloaded && !isSelected ? "cursor-pointer" : ""}`}
    >
      <div className="flex items-center gap-1.5 p-2">
        <div className="shrink-0">
          {isDownloaded ? (
            <div
              className={`w-1.5 h-1.5 rounded-full ${
                isSelected
                  ? "bg-primary shadow-[0_0_6px_oklch(0.62_0.22_260/0.6)] animate-[pulse-glow_2s_ease-in-out_infinite]"
                  : "bg-success shadow-[0_0_4px_rgba(34,197,94,0.5)]"
              }`}
            />
          ) : isDownloading ? (
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shadow-[0_0_4px_rgba(245,158,11,0.5)] animate-[spinner-rotate_1s_linear_infinite]" />
          ) : (
            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20" />
          )}
        </div>

        <div className="flex-1 min-w-0 flex items-center gap-1.5">
          <ProviderIcon provider={provider} className="w-3.5 h-3.5 shrink-0" />
          <span className="font-semibold text-sm text-foreground truncate tracking-tight">
            {name}
          </span>
          <span className="text-xs text-muted-foreground/50 tabular-nums shrink-0">
            {actualSizeMb ? `${actualSizeMb}MB` : size}
          </span>
          {recommended && (
            <span className={cardStyles.badges.recommended}>{t("common.recommended")}</span>
          )}
          {languageLabel && (
            <span className="text-xs text-muted-foreground/50 font-medium shrink-0">
              {languageLabel}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {isDownloaded ? (
            <>
              {isSelected && (
                <span className="text-xs font-medium text-primary px-2 py-0.5 bg-primary/10 rounded-sm">
                  {t("common.active")}
                </span>
              )}
              <Button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground/40 hover:text-destructive opacity-0 group-hover:opacity-100 transition-[color,opacity,transform] active:scale-95"
              >
                <Trash2 size={12} />
              </Button>
            </>
          ) : isDownloading ? (
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              disabled={isCancelling || isInstalling}
              size="sm"
              variant="outline"
              className="h-6 px-2.5 text-xs text-destructive border-destructive/25 hover:bg-destructive/8"
            >
              <X size={11} className="mr-0.5" />
              {isCancelling ? "..." : t("common.cancel")}
            </Button>
          ) : (
            <Button
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
              size="sm"
              variant="default"
              className="h-6 px-2.5 text-xs"
            >
              <Download size={11} className="mr-1" />
              {t("common.download")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

interface TranscriptionModelPickerProps {
  selectedCloudProvider: string;
  onCloudProviderSelect: (providerId: string) => void;
  selectedCloudModel: string;
  onCloudModelSelect: (modelId: string) => void;
  selectedLocalModel: string;
  onLocalModelSelect: (modelId: string) => void;
  selectedLocalProvider?: string;
  onLocalProviderSelect?: (providerId: string) => void;
  useLocalWhisper: boolean;
  onModeChange: (useLocal: boolean) => void;
  cloudTranscriptionBaseUrl?: string;
  setCloudTranscriptionBaseUrl?: (url: string) => void;
  className?: string;
  variant?: "onboarding" | "settings";
  mode?: "cloud" | "local";
  streamingOnly?: boolean;
}

const CLOUD_PROVIDER_TABS = [
  { id: "openai", name: "OpenAI" },
  { id: "groq", name: "Groq" },
  { id: "xai", name: "xAI" },
  { id: "mistral", name: "Mistral" },
  { id: "corti", name: "Corti" },
  { id: "tinfoil", name: "Tinfoil" },
  { id: "custom", name: "Custom" },
];

interface ProviderCredentialField {
  key:
    | "openaiApiKey"
    | "groqApiKey"
    | "xaiApiKey"
    | "mistralApiKey"
    | "cortiClientId"
    | "cortiClientSecret"
    | "cortiEnvironment"
    | "cortiTenant"
    | "tinfoilApiKey";
  input: "secret" | "text" | "select";
  labelKey?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

const PROVIDER_CREDENTIALS: Record<
  string,
  { consoleUrl: string; fields: ProviderCredentialField[] }
> = {
  openai: {
    consoleUrl: "https://platform.openai.com/api-keys",
    fields: [{ key: "openaiApiKey", input: "secret" }],
  },
  groq: {
    consoleUrl: "https://console.groq.com/keys",
    fields: [{ key: "groqApiKey", input: "secret" }],
  },
  xai: {
    consoleUrl: "https://console.x.ai",
    fields: [{ key: "xaiApiKey", input: "secret" }],
  },
  mistral: {
    consoleUrl: "https://console.mistral.ai/api-keys",
    fields: [{ key: "mistralApiKey", input: "secret" }],
  },
  corti: {
    consoleUrl: "https://www.corti.ai/?utm_source=referral&utm_content=&utm_campaign=openwhispr",
    fields: [
      { key: "cortiClientId", input: "secret", labelKey: "transcription.corti.clientId" },
      { key: "cortiClientSecret", input: "secret", labelKey: "transcription.corti.clientSecret" },
      {
        key: "cortiEnvironment",
        input: "select",
        labelKey: "transcription.corti.environment",
        options: [
          { value: "us", label: "US" },
          { value: "eu", label: "EU" },
        ],
      },
      {
        key: "cortiTenant",
        input: "text",
        labelKey: "transcription.corti.tenant",
        placeholder: "base",
      },
    ],
  },
  tinfoil: {
    consoleUrl: "https://tinfoil.sh/inference?utm_source=referral&utm_campaign=openwhispr",
    fields: [{ key: "tinfoilApiKey", input: "secret" }],
  },
};

const VALID_CLOUD_PROVIDER_IDS = CLOUD_PROVIDER_TABS.map((p) => p.id);

const TINFOIL_AUDIO_DOCS_URL = "https://docs.tinfoil.sh/models/audio";

const LOCAL_PROVIDER_TABS: Array<{ id: string; name: string; disabled?: boolean }> = [
  { id: "whisper", name: "OpenAI" },
  { id: "nvidia", name: "NVIDIA" },
];

interface ModeToggleProps {
  useLocalWhisper: boolean;
  onModeChange: (useLocal: boolean) => void;
}

function ModeToggle({ useLocalWhisper, onModeChange }: ModeToggleProps) {
  const { t } = useTranslation();
  return (
    <div className="relative flex p-0.5 rounded-lg bg-surface-1/80 backdrop-blur-xl dark:bg-surface-1 border border-border/60 dark:border-white/8 shadow-(--shadow-metallic-light) dark:shadow-(--shadow-metallic-dark)">
      <div
        className={`absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-md bg-card border border-border/60 dark:border-border-subtle shadow-(--shadow-metallic-light) dark:shadow-(--shadow-metallic-dark) transition-transform duration-200 ease-out ${
          useLocalWhisper ? "translate-x-[calc(100%)]" : "translate-x-0"
        }`}
      />
      <button
        onClick={() => onModeChange(false)}
        className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md transition-colors duration-150 ${
          !useLocalWhisper ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Cloud className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">{t("common.cloud")}</span>
      </button>
      <button
        onClick={() => onModeChange(true)}
        className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md transition-colors duration-150 ${
          useLocalWhisper ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <Lock className="w-3.5 h-3.5" />
        <span className="text-xs font-medium">{t("common.local")}</span>
      </button>
    </div>
  );
}

export default function TranscriptionModelPicker({
  selectedCloudProvider,
  onCloudProviderSelect,
  selectedCloudModel,
  onCloudModelSelect,
  selectedLocalModel,
  onLocalModelSelect,
  selectedLocalProvider = "whisper",
  onLocalProviderSelect,
  useLocalWhisper,
  onModeChange,
  cloudTranscriptionBaseUrl = "",
  setCloudTranscriptionBaseUrl,
  className = "",
  variant = "settings",
  mode,
  streamingOnly = false,
}: TranscriptionModelPickerProps) {
  const { t } = useTranslation();
  const openaiApiKey = useSettingsStore((s) => s.openaiApiKey);
  const setOpenaiApiKey = useSettingsStore((s) => s.setOpenaiApiKey);
  const groqApiKey = useSettingsStore((s) => s.groqApiKey);
  const setGroqApiKey = useSettingsStore((s) => s.setGroqApiKey);
  const xaiApiKey = useSettingsStore((s) => s.xaiApiKey);
  const setXaiApiKey = useSettingsStore((s) => s.setXaiApiKey);
  const mistralApiKey = useSettingsStore((s) => s.mistralApiKey);
  const setMistralApiKey = useSettingsStore((s) => s.setMistralApiKey);
  const cortiClientId = useSettingsStore((s) => s.cortiClientId);
  const setCortiClientId = useSettingsStore((s) => s.setCortiClientId);
  const cortiClientSecret = useSettingsStore((s) => s.cortiClientSecret);
  const setCortiClientSecret = useSettingsStore((s) => s.setCortiClientSecret);
  const cortiEnvironment = useSettingsStore((s) => s.cortiEnvironment);
  const setCortiEnvironment = useSettingsStore((s) => s.setCortiEnvironment);
  const cortiTenant = useSettingsStore((s) => s.cortiTenant);
  const setCortiTenant = useSettingsStore((s) => s.setCortiTenant);
  const tinfoilApiKey = useSettingsStore((s) => s.tinfoilApiKey);
  const setTinfoilApiKey = useSettingsStore((s) => s.setTinfoilApiKey);
  const customTranscriptionApiKey = useSettingsStore((s) => s.customTranscriptionApiKey);
  const setCustomTranscriptionApiKey = useSettingsStore((s) => s.setCustomTranscriptionApiKey);
  const effectiveLocal = mode === "local" ? true : mode === "cloud" ? false : useLocalWhisper;
  const [localModels, setLocalModels] = useState<LocalModel[]>([]);
  const [parakeetModels, setParakeetModels] = useState<LocalModel[]>([]);
  const [internalLocalProvider, setInternalLocalProvider] = useState(selectedLocalProvider);
  const hasLoadedRef = useRef(false);
  const hasLoadedParakeetRef = useRef(false);
  const [cudaStatus, setCudaStatus] = useState<CudaWhisperStatus | null>(null);
  const [cudaDownloading, setCudaDownloading] = useState(false);
  const [cudaProgress, setCudaProgress] = useState<DownloadProgress>({
    downloadedBytes: 0,
    totalBytes: 0,
    percentage: 0,
  });
  const [cudaDismissed, setCudaDismissed] = useState(false);

  useEffect(() => {
    if (selectedLocalProvider !== internalLocalProvider) {
      setInternalLocalProvider(selectedLocalProvider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sync prop→state: only re-run when the prop changes
  }, [selectedLocalProvider]);
  const localModelsLoadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const parakeetModelsLoadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const loadLocalModelsRef = useRef<(() => Promise<void>) | null>(null);
  const loadParakeetModelsRef = useRef<(() => Promise<void>) | null>(null);
  const ensureValidCloudSelectionRef = useRef<(() => void) | null>(null);
  const selectedLocalModelRef = useRef(selectedLocalModel);
  const onLocalModelSelectRef = useRef(onLocalModelSelect);

  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const colorScheme: ColorScheme = variant === "settings" ? "purple" : "blue";
  const styles = useMemo(() => MODEL_PICKER_COLORS[colorScheme], [colorScheme]);
  const cloudProviders = useMemo(
    () => (streamingOnly ? getStreamingTranscriptionProviders() : getTranscriptionProviders()),
    [streamingOnly]
  );
  const cloudProviderTabs = useMemo(() => {
    const visibleIds = new Set([...cloudProviders.map((p) => p.id), "custom"]);
    return CLOUD_PROVIDER_TABS.filter((p) => visibleIds.has(p.id)).map((provider) =>
      provider.id === "custom" ? { ...provider, name: t("transcription.customProvider") } : provider
    );
  }, [cloudProviders, t]);

  useEffect(() => {
    selectedLocalModelRef.current = selectedLocalModel;
  }, [selectedLocalModel]);
  useEffect(() => {
    onLocalModelSelectRef.current = onLocalModelSelect;
  }, [onLocalModelSelect]);

  const validateAndSelectModel = useCallback((loadedModels: LocalModel[]) => {
    const current = selectedLocalModelRef.current;
    if (!current) return;

    const downloaded = loadedModels.filter((m) => m.downloaded);
    const isCurrentDownloaded = loadedModels.find((m) => m.model === current)?.downloaded;

    if (!isCurrentDownloaded && downloaded.length > 0) {
      onLocalModelSelectRef.current(downloaded[0].model);
    } else if (!isCurrentDownloaded && downloaded.length === 0) {
      onLocalModelSelectRef.current("");
    }
  }, []);

  const loadLocalModels = useCallback(() => {
    const load = async () => {
      try {
        const result = await window.electronAPI?.listWhisperModels();
        if (result?.success) {
          setLocalModels(result.models);
          validateAndSelectModel(result.models);
        }
      } catch (error) {
        logger.error("Failed to load models", { error }, "models");
        setLocalModels([]);
      }
    };

    const queuedLoad = localModelsLoadQueueRef.current.then(load);
    localModelsLoadQueueRef.current = queuedLoad;
    return queuedLoad;
  }, [validateAndSelectModel]);

  const loadParakeetModels = useCallback(() => {
    const load = async () => {
      try {
        const result = await window.electronAPI?.listParakeetModels();
        if (result?.success) {
          setParakeetModels(result.models);
        }
      } catch (error) {
        logger.error("Failed to load Parakeet models", { error }, "models");
        setParakeetModels([]);
      }
    };

    const queuedLoad = parakeetModelsLoadQueueRef.current.then(load);
    parakeetModelsLoadQueueRef.current = queuedLoad;
    return queuedLoad;
  }, []);

  const ensureValidCloudSelection = useCallback(() => {
    const isValidProvider = VALID_CLOUD_PROVIDER_IDS.includes(selectedCloudProvider);

    if (!isValidProvider) {
      const knownProviderUrls = cloudProviders.map((p) => p.baseUrl);
      const hasCustomUrl =
        cloudTranscriptionBaseUrl &&
        cloudTranscriptionBaseUrl.trim() !== "" &&
        cloudTranscriptionBaseUrl !== API_ENDPOINTS.TRANSCRIPTION_BASE &&
        !knownProviderUrls.includes(cloudTranscriptionBaseUrl);

      if (hasCustomUrl) {
        onCloudProviderSelect("custom");
      } else {
        const firstProvider = cloudProviders[0];
        if (firstProvider) {
          onCloudProviderSelect(firstProvider.id);
          if (firstProvider.models?.length) {
            onCloudModelSelect(firstProvider.models[0].id);
          }
        }
      }
    } else if (selectedCloudProvider !== "custom" && !selectedCloudModel) {
      const provider = cloudProviders.find((p) => p.id === selectedCloudProvider);
      if (provider?.models?.length) {
        onCloudModelSelect(provider.models[0].id);
      }
    }
  }, [
    cloudProviders,
    cloudTranscriptionBaseUrl,
    selectedCloudProvider,
    selectedCloudModel,
    onCloudProviderSelect,
    onCloudModelSelect,
  ]);

  useEffect(() => {
    loadLocalModelsRef.current = loadLocalModels;
  }, [loadLocalModels]);
  useEffect(() => {
    loadParakeetModelsRef.current = loadParakeetModels;
  }, [loadParakeetModels]);
  useEffect(() => {
    ensureValidCloudSelectionRef.current = ensureValidCloudSelection;
  }, [ensureValidCloudSelection]);

  useEffect(() => {
    if (!effectiveLocal) return;

    if (internalLocalProvider === "whisper" && !hasLoadedRef.current) {
      hasLoadedRef.current = true;
      loadLocalModelsRef.current?.();
    } else if (internalLocalProvider === "nvidia" && !hasLoadedParakeetRef.current) {
      hasLoadedParakeetRef.current = true;
      loadParakeetModelsRef.current?.();
    }
  }, [effectiveLocal, internalLocalProvider]);

  useEffect(() => {
    if (effectiveLocal) return;

    hasLoadedRef.current = false;
    hasLoadedParakeetRef.current = false;
    ensureValidCloudSelectionRef.current?.();
  }, [effectiveLocal]);

  useEffect(() => {
    const handleModelsCleared = () => {
      loadLocalModels();
      loadParakeetModels();
    };
    window.addEventListener("openwhispr-models-cleared", handleModelsCleared);
    return () => window.removeEventListener("openwhispr-models-cleared", handleModelsCleared);
  }, [loadLocalModels, loadParakeetModels]);

  useEffect(() => {
    if (!effectiveLocal || internalLocalProvider !== "whisper") return;
    if (getCachedPlatform() === "darwin") return;
    window.electronAPI
      ?.getCudaWhisperStatus?.()
      ?.then(setCudaStatus)
      .catch(() => {});
  }, [effectiveLocal, internalLocalProvider]);

  useEffect(() => {
    if (!cudaDownloading) return;
    const cleanup = window.electronAPI?.onCudaDownloadProgress?.((data) => {
      setCudaProgress(data);
    });
    return cleanup;
  }, [cudaDownloading]);

  const handleCudaDownload = async () => {
    setCudaDownloading(true);
    try {
      const result = await window.electronAPI?.downloadCudaWhisperBinary?.();
      if (result?.success) {
        const status = await window.electronAPI?.getCudaWhisperStatus?.();
        setCudaStatus(status || null);
      }
    } finally {
      setCudaDownloading(false);
    }
  };

  const handleCudaDelete = async () => {
    await window.electronAPI?.deleteCudaWhisperBinary?.();
    const status = await window.electronAPI?.getCudaWhisperStatus?.();
    setCudaStatus(status || null);
  };

  const handleCudaCancel = async () => {
    await window.electronAPI?.cancelCudaWhisperDownload?.();
    setCudaDownloading(false);
  };

  const {
    downloadingModel,
    downloadProgress,
    downloadModel,
    deleteModel,
    isDownloadingModel,
    isInstalling,
    cancelDownload,
    isCancelling,
  } = useModelDownload({
    modelType: "whisper",
    onDownloadComplete: loadLocalModels,
  });

  const {
    downloadingModel: downloadingParakeetModel,
    downloadProgress: parakeetDownloadProgress,
    downloadModel: downloadParakeetModel,
    deleteModel: deleteParakeetModel,
    isDownloadingModel: isDownloadingParakeetModel,
    isInstalling: isInstallingParakeet,
    cancelDownload: cancelParakeetDownload,
    isCancelling: isCancellingParakeet,
  } = useModelDownload({
    modelType: "parakeet",
    onDownloadComplete: loadParakeetModels,
  });

  const handleModeChange = useCallback(
    (isLocal: boolean) => {
      onModeChange(isLocal);
      if (!isLocal) ensureValidCloudSelection();
    },
    [onModeChange, ensureValidCloudSelection]
  );

  const handleCloudProviderChange = useCallback(
    (providerId: string) => {
      onCloudProviderSelect(providerId);
      const provider = cloudProviders.find((p) => p.id === providerId);

      if (providerId === "custom") {
        onCloudModelSelect("whisper-1");
        return;
      }

      if (provider) {
        setCloudTranscriptionBaseUrl?.(provider.baseUrl);
        if (provider.models?.length) {
          onCloudModelSelect(provider.models[0].id);
        }
      }
    },
    [cloudProviders, onCloudProviderSelect, onCloudModelSelect, setCloudTranscriptionBaseUrl]
  );

  const handleLocalProviderChange = useCallback(
    (providerId: string) => {
      const tab = LOCAL_PROVIDER_TABS.find((t) => t.id === providerId);
      if (tab?.disabled) return;
      setInternalLocalProvider(providerId);
      onLocalProviderSelect?.(providerId);
    },
    [onLocalProviderSelect]
  );

  const handleWhisperModelSelect = useCallback(
    (modelId: string) => {
      onLocalProviderSelect?.("whisper");
      setInternalLocalProvider("whisper");
      onLocalModelSelect(modelId);
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleParakeetModelSelect = useCallback(
    (modelId: string) => {
      onLocalProviderSelect?.("nvidia");
      setInternalLocalProvider("nvidia");
      onLocalModelSelect(modelId);
    },
    [onLocalModelSelect, onLocalProviderSelect]
  );

  const handleBaseUrlBlur = useCallback(() => {
    if (!setCloudTranscriptionBaseUrl || selectedCloudProvider !== "custom") return;

    const trimmed = (cloudTranscriptionBaseUrl || "").trim();
    if (!trimmed) return;

    const normalized = normalizeBaseUrl(trimmed);

    if (normalized && normalized !== cloudTranscriptionBaseUrl) {
      setCloudTranscriptionBaseUrl(normalized);
    }
    if (normalized) {
      for (const provider of cloudProviders) {
        const providerNormalized = normalizeBaseUrl(provider.baseUrl);
        if (normalized === providerNormalized) {
          onCloudProviderSelect(provider.id);
          onCloudModelSelect("whisper-1");
          break;
        }
      }
    }
  }, [
    cloudTranscriptionBaseUrl,
    selectedCloudProvider,
    setCloudTranscriptionBaseUrl,
    onCloudProviderSelect,
    onCloudModelSelect,
    cloudProviders,
  ]);

  const handleDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteModel(modelId, async () => {
            const result = await window.electronAPI?.listWhisperModels();
            if (result?.success) {
              setLocalModels(result.models);
              validateAndSelectModel(result.models);
            }
          });
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteModel, validateAndSelectModel, t]
  );

  const currentCloudProvider = useMemo<TranscriptionProviderData | undefined>(
    () => cloudProviders.find((p) => p.id === selectedCloudProvider),
    [cloudProviders, selectedCloudProvider]
  );

  const providerCredentials =
    PROVIDER_CREDENTIALS[selectedCloudProvider] ?? PROVIDER_CREDENTIALS.openai;
  const credentialValues: Record<ProviderCredentialField["key"], string> = {
    openaiApiKey,
    groqApiKey,
    xaiApiKey,
    mistralApiKey,
    cortiClientId,
    cortiClientSecret,
    cortiEnvironment,
    cortiTenant,
    tinfoilApiKey,
  };
  const credentialSetters: Record<ProviderCredentialField["key"], (value: string) => void> = {
    openaiApiKey: setOpenaiApiKey,
    groqApiKey: setGroqApiKey,
    xaiApiKey: setXaiApiKey,
    mistralApiKey: setMistralApiKey,
    cortiClientId: setCortiClientId,
    cortiClientSecret: setCortiClientSecret,
    cortiEnvironment: setCortiEnvironment,
    cortiTenant: setCortiTenant,
    tinfoilApiKey: setTinfoilApiKey,
  };

  const cloudModelOptions = useMemo(() => {
    if (!currentCloudProvider) return [];
    const { icon, invertInDark } = getRemoteProviderIcon(selectedCloudProvider);
    return currentCloudProvider.models.map((m) => ({
      value: m.id,
      label: m.name,
      description: m.descriptionKey
        ? t(m.descriptionKey, { defaultValue: m.description })
        : m.description,
      icon,
      invertInDark,
    }));
  }, [currentCloudProvider, selectedCloudProvider, t]);

  const progressDisplay = useMemo(() => {
    if (!effectiveLocal) return null;

    if (downloadingModel && internalLocalProvider === "whisper") {
      const modelInfo = WHISPER_MODEL_INFO[downloadingModel];
      return (
        <DownloadProgressBar
          modelName={modelInfo?.name || downloadingModel}
          progress={downloadProgress}
          isInstalling={isInstalling}
        />
      );
    }

    if (downloadingParakeetModel && internalLocalProvider === "nvidia") {
      const modelInfo = PARAKEET_MODEL_INFO[downloadingParakeetModel];
      return (
        <DownloadProgressBar
          modelName={modelInfo?.name || downloadingParakeetModel}
          progress={parakeetDownloadProgress}
          isInstalling={isInstallingParakeet}
        />
      );
    }

    return null;
  }, [
    downloadingModel,
    downloadProgress,
    isInstalling,
    downloadingParakeetModel,
    parakeetDownloadProgress,
    isInstallingParakeet,
    effectiveLocal,
    internalLocalProvider,
  ]);

  const renderLocalModels = () => {
    const modelsToRender =
      localModels.length === 0
        ? Object.entries(WHISPER_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : localModels;

    return (
      <div className="space-y-0.5">
        {modelsToRender.map((model) => {
          const modelId = model.model;
          const info = WHISPER_MODEL_INFO[modelId] ?? {
            name: modelId,
            description: t("transcription.fallback.whisperModelDescription"),
            size: t("common.unknown"),
            recommended: false,
          };

          return (
            <LocalModelCard
              key={modelId}
              modelId={modelId}
              name={info.name}
              description={info.description}
              size={info.size}
              actualSizeMb={model.size_mb}
              isSelected={modelId === selectedLocalModel}
              isDownloaded={model.downloaded ?? false}
              isDownloading={isDownloadingModel(modelId)}
              isCancelling={isCancelling}
              isInstalling={isInstalling}
              recommended={info.recommended}
              provider="whisper"
              onSelect={() => handleWhisperModelSelect(modelId)}
              onDelete={() => handleDelete(modelId)}
              onDownload={() =>
                downloadModel(modelId, (downloadedId) => {
                  setLocalModels((prev) =>
                    prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                  );
                  handleWhisperModelSelect(downloadedId);
                })
              }
              onCancel={cancelDownload}
              styles={styles}
            />
          );
        })}
      </div>
    );
  };

  const handleParakeetDelete = useCallback(
    (modelId: string) => {
      showConfirmDialog({
        title: t("transcription.deleteModel.title"),
        description: t("transcription.deleteModel.description"),
        onConfirm: async () => {
          await deleteParakeetModel(modelId, async () => {
            const result = await window.electronAPI?.listParakeetModels();
            if (result?.success) {
              setParakeetModels(result.models);
            }
          });
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, deleteParakeetModel, t]
  );

  const renderParakeetModels = () => {
    const modelsToRender =
      parakeetModels.length === 0
        ? Object.entries(PARAKEET_MODEL_INFO).map(([modelId, info]) => ({
            model: modelId,
            downloaded: false,
            size_mb: info.sizeMb,
          }))
        : parakeetModels;

    return (
      <div className="space-y-0.5">
        {modelsToRender.map((model) => {
          const modelId = model.model;
          const info = PARAKEET_MODEL_INFO[modelId] ?? {
            name: modelId,
            description: t("transcription.fallback.parakeetModelDescription"),
            size: t("common.unknown"),
            language: "en",
            recommended: false,
          };

          return (
            <LocalModelCard
              key={modelId}
              modelId={modelId}
              name={info.name}
              description={info.description}
              size={info.size}
              actualSizeMb={model.size_mb}
              isSelected={modelId === selectedLocalModel}
              isDownloaded={model.downloaded ?? false}
              isDownloading={isDownloadingParakeetModel(modelId)}
              isCancelling={isCancellingParakeet}
              isInstalling={isInstallingParakeet}
              recommended={info.recommended}
              provider="nvidia"
              onSelect={() => handleParakeetModelSelect(modelId)}
              onDelete={() => handleParakeetDelete(modelId)}
              onDownload={() =>
                downloadParakeetModel(modelId, (downloadedId) => {
                  setParakeetModels((prev) =>
                    prev.map((m) => (m.model === downloadedId ? { ...m, downloaded: true } : m))
                  );
                  handleParakeetModelSelect(downloadedId);
                })
              }
              onCancel={cancelParakeetDownload}
              styles={styles}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div className={`space-y-2 ${className}`}>
      {!mode && <ModeToggle useLocalWhisper={effectiveLocal} onModeChange={handleModeChange} />}

      {!effectiveLocal ? (
        <>
          <ProviderTabs
            providers={cloudProviderTabs}
            selectedId={selectedCloudProvider}
            onSelect={handleCloudProviderChange}
            colorScheme="purple"
            wrap
          />

          <div>
            {selectedCloudProvider === "custom" ? (
              <div className="space-y-2">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    {t("transcription.endpointUrl")}
                  </label>
                  <Input
                    value={cloudTranscriptionBaseUrl}
                    onChange={(e) => setCloudTranscriptionBaseUrl?.(e.target.value)}
                    onBlur={handleBaseUrlBlur}
                    placeholder="https://your-api.example.com/v1"
                    className="h-8 text-sm"
                  />
                </div>

                <ApiKeyInput
                  apiKey={customTranscriptionApiKey}
                  setApiKey={setCustomTranscriptionApiKey}
                  label={t("transcription.apiKeyOptional")}
                  helpText=""
                />

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-foreground">
                    {t("common.model")}
                  </label>
                  <Input
                    value={selectedCloudModel}
                    onChange={(e) => onCloudModelSelect(e.target.value)}
                    placeholder="whisper-1"
                    className="h-8 text-sm"
                  />
                </div>

                {/azure\.com/i.test(cloudTranscriptionBaseUrl || "") && (
                  <p className="text-xs text-muted-foreground">{t("transcription.azureHint")}</p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {providerCredentials.fields.map((field, index) => (
                  <div key={field.key} className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-foreground">
                        {field.labelKey ? t(field.labelKey) : t("common.apiKey")}
                      </label>
                      {index === 0 && (
                        <GetApiKeyLink
                          url={providerCredentials.consoleUrl}
                          labelKey="transcription.getKey"
                          className="text-xs text-primary/70 hover:text-primary transition-colors cursor-pointer"
                        />
                      )}
                    </div>
                    {field.input === "secret" ? (
                      <ApiKeyInput
                        apiKey={credentialValues[field.key]}
                        setApiKey={credentialSetters[field.key]}
                        label=""
                        helpText=""
                      />
                    ) : field.input === "select" ? (
                      <Select
                        value={credentialValues[field.key]}
                        onValueChange={credentialSetters[field.key]}
                      >
                        <SelectTrigger className="h-8 text-sm">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {field.options?.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={credentialValues[field.key]}
                        onChange={(e) => credentialSetters[field.key](e.target.value)}
                        placeholder={field.placeholder}
                        className="h-8 text-sm"
                      />
                    )}
                  </div>
                ))}

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-foreground">{t("common.model")}</label>
                  <ModelCardList
                    models={cloudModelOptions}
                    selectedModel={selectedCloudModel}
                    onModelSelect={onCloudModelSelect}
                    colorScheme="purple"
                  />
                  {selectedCloudProvider === "tinfoil" && (
                    <p className="text-xs text-muted-foreground/70">
                      {t("transcription.tinfoil.transportNote")}{" "}
                      <a
                        href={TINFOIL_AUDIO_DOCS_URL}
                        onClick={createExternalLinkHandler(TINFOIL_AUDIO_DOCS_URL)}
                        className="text-primary/70 hover:text-primary transition-colors"
                      >
                        {t("transcription.tinfoil.docsLink")}
                      </a>
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <ProviderTabs
            providers={LOCAL_PROVIDER_TABS}
            selectedId={internalLocalProvider}
            onSelect={handleLocalProviderChange}
            colorScheme="purple"
          />

          {progressDisplay}

          {cudaDownloading && internalLocalProvider === "whisper" && (
            <div>
              <DownloadProgressBar modelName="GPU acceleration" progress={cudaProgress} />
              <div className="px-2.5 pb-1 flex justify-end">
                <button
                  onClick={handleCudaCancel}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {internalLocalProvider === "whisper" &&
            !cudaDismissed &&
            !cudaDownloading &&
            getCachedPlatform() !== "darwin" &&
            cudaStatus?.gpuInfo.hasNvidiaGpu && (
              <div className="rounded-md border border-border bg-surface-1 p-2.5">
                {cudaStatus.downloaded ? (
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Check size={13} className="text-success" />
                      <span className="text-xs font-medium text-foreground">{t("gpu.active")}</span>
                    </div>
                    <Button
                      onClick={handleCudaDelete}
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                    >
                      {t("gpu.remove")}
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-start gap-2.5">
                    <Zap size={13} className="text-primary shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-foreground">
                        {t("gpu.transcriptionBanner")}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Button
                          onClick={handleCudaDownload}
                          size="sm"
                          variant="default"
                          className="h-6 px-2.5 text-xs"
                        >
                          {t("gpu.enableButton")}
                        </Button>
                        <button
                          onClick={() => setCudaDismissed(true)}
                          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {t("gpu.dismiss")}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

          <div>
            {internalLocalProvider === "whisper" && renderLocalModels()}
            {internalLocalProvider === "nvidia" && renderParakeetModels()}
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => !open && hideConfirmDialog()}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
    </div>
  );
}
