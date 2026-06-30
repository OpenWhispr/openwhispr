import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  LlamaServerStatus,
  LlamaVulkanStatus,
  VulkanGpuResult,
  LlamaVulkanDownloadProgress,
  InferenceMode,
} from "../types/electron";
import { Button } from "./ui/button";
import { Cloud, Lock, Zap } from "lucide-react";
import ApiKeyInput from "./ui/ApiKeyInput";
import ModelCardList from "./ui/ModelCardList";
import LocalModelPicker, { type LocalProvider } from "./LocalModelPicker";
import { ProviderTabs } from "./ui/ProviderTabs";
import OpenAICompatiblePanel from "./OpenAICompatiblePanel";
import { API_ENDPOINTS, normalizeBaseUrl } from "../config/constants";
import logger from "../utils/logger";
import { REASONING_PROVIDERS } from "../models/ModelRegistry";
import { modelRegistry } from "../models/ModelRegistry";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import { GetApiKeyLink } from "./ui/GetApiKeyLink";
import { getCachedPlatform } from "../utils/platform";
import { useSettingsStore } from "../stores/settingsStore";

type CloudModelOption = {
  value: string;
  label: string;
  description?: string;
  descriptionKey?: string;
  icon?: string;
  ownedBy?: string;
  invertInDark?: boolean;
};

const OPENROUTER_TAB = "openrouter";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

const CLOUD_PROVIDER_IDS = ["openai", "anthropic", "gemini", "groq", OPENROUTER_TAB, "custom"];

// OpenRouter is the custom (OpenAI-compatible) provider pinned to its endpoint,
// surfaced as its own tab. Map between the tab id and the persisted provider.
function tabToStored(tab: string): { provider: string; baseUrl?: string } {
  return tab === OPENROUTER_TAB
    ? { provider: "custom", baseUrl: API_ENDPOINTS.OPENROUTER_BASE }
    : { provider: tab };
}
function storedToTab(provider: string, baseUrl: string): string {
  if (provider === "custom" && normalizeBaseUrl(baseUrl) === API_ENDPOINTS.OPENROUTER_BASE) {
    return OPENROUTER_TAB;
  }
  return provider;
}

interface ReasoningModelSelectorProps {
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
  localReasoningProvider: string;
  setLocalReasoningProvider: (provider: string) => void;
  cloudReasoningBaseUrl: string;
  setCloudReasoningBaseUrl: (value: string) => void;
  customReasoningApiKey?: string;
  setCustomReasoningApiKey?: (key: string) => void;
  setReasoningMode?: (mode: InferenceMode) => void;
  mode?: "cloud" | "local";
}

function GpuStatusBadge() {
  const { t } = useTranslation();
  const [serverStatus, setServerStatus] = useState<LlamaServerStatus | null>(null);
  const [vulkanStatus, setVulkanStatus] = useState<LlamaVulkanStatus | null>(null);
  const [gpuResult, setGpuResult] = useState<VulkanGpuResult | null>(null);
  const [progress, setProgress] = useState<LlamaVulkanDownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [activationFailed, setActivationFailed] = useState(false);
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem("llamaVulkanBannerDismissed") === "true"
  );
  const platform = getCachedPlatform();

  useEffect(() => {
    const poll = () => {
      window.electronAPI
        ?.llamaServerStatus?.()
        .then(setServerStatus)
        .catch(() => {});
      if (platform !== "darwin") {
        window.electronAPI
          ?.getLlamaVulkanStatus?.()
          .then(setVulkanStatus)
          .catch(() => {});
      }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [platform]);

  useEffect(() => {
    if (platform !== "darwin") {
      window.electronAPI
        ?.detectVulkanGpu?.()
        .then(setGpuResult)
        .catch(() => {});
    }
  }, [platform]);

  useEffect(() => {
    const cleanup = window.electronAPI?.onLlamaVulkanDownloadProgress?.((data) => {
      setProgress(data);
    });
    return () => cleanup?.();
  }, []);

  useEffect(() => {
    if (!activating) return;
    if (serverStatus?.gpuAccelerated || vulkanStatus?.downloaded) {
      setActivating(false);
      setActivationFailed(false);
      return;
    }
    const timeout = setTimeout(() => {
      setActivating(false);
      setActivationFailed(true);
    }, 10000);
    const fastPoll = setInterval(() => {
      window.electronAPI
        ?.llamaServerStatus?.()
        .then(setServerStatus)
        .catch(() => {});
      window.electronAPI
        ?.getLlamaVulkanStatus?.()
        .then(setVulkanStatus)
        .catch(() => {});
    }, 1000);
    return () => {
      clearTimeout(timeout);
      clearInterval(fastPoll);
    };
  }, [activating, serverStatus?.gpuAccelerated, vulkanStatus?.downloaded]);

  const handleDownload = async () => {
    setDownloading(true);
    setError(null);
    try {
      const result = await window.electronAPI?.downloadLlamaVulkanBinary?.();
      if (result?.success) {
        setVulkanStatus((prev) => (prev ? { ...prev, downloaded: true } : prev));
        await window.electronAPI?.llamaGpuReset?.();
        setActivating(true);
        setActivationFailed(false);
      } else if (result && !result.cancelled) {
        setError(result.error || t("gpu.activationFailed"));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("gpu.activationFailed"));
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  };

  const handleDelete = async () => {
    await window.electronAPI?.deleteLlamaVulkanBinary?.();
    setVulkanStatus((prev) => (prev ? { ...prev, downloaded: false } : prev));
  };

  const handleRetry = async () => {
    setActivationFailed(false);
    setActivating(true);
    await window.electronAPI?.llamaGpuReset?.();
  };

  // State 1: macOS
  if (platform === "darwin") {
    if (!serverStatus?.running) return null;
    return (
      <div className="flex items-center gap-1.5 mt-2 px-1">
        <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-success" />
        <span className="text-xs text-muted-foreground">{t("gpu.active")}</span>
      </div>
    );
  }

  // State 3: Downloading
  if (downloading && progress) {
    return (
      <div className="flex items-center gap-2 mt-2 px-1">
        <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${progress.percentage}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">{progress.percentage}%</span>
        <button
          type="button"
          onClick={() => window.electronAPI?.cancelLlamaVulkanDownload?.()}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t("gpu.cancel")}
        </button>
      </div>
    );
  }

  // State 3b: Error
  if (error) {
    return (
      <div className="flex items-center gap-1.5 mt-2 px-1">
        <span className="text-xs text-destructive">{error}</span>
        <button
          type="button"
          onClick={() => setError(null)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-1"
        >
          {t("gpu.dismiss")}
        </button>
      </div>
    );
  }

  // State 5: Activating
  if (activating) {
    return (
      <div className="flex items-center gap-1.5 mt-2 px-1">
        <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-primary animate-pulse" />
        <span className="text-xs text-muted-foreground">{t("gpu.activating")}</span>
      </div>
    );
  }

  // State 4: Downloaded + GPU active
  if (vulkanStatus?.downloaded) {
    const isGpu = serverStatus?.gpuAccelerated && serverStatus?.backend === "vulkan";

    // State 6: Activation failed
    if (!isGpu && activationFailed) {
      return (
        <div className="flex items-center gap-1.5 mt-2 px-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0 bg-warning" />
          <span className="text-xs text-muted-foreground">{t("gpu.activationFailed")}</span>
          <button
            type="button"
            onClick={handleRetry}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-1"
          >
            {t("gpu.retry")}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
          >
            {t("gpu.remove")}
          </button>
        </div>
      );
    }

    // State 4: GPU active or just downloaded
    return (
      <div className="flex items-center gap-1.5 mt-2 px-1">
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${isGpu ? "bg-success" : "bg-primary"}`}
        />
        <span className="text-xs text-muted-foreground">
          {isGpu ? t("gpu.active") : t("gpu.ready")}
        </span>
        <button
          type="button"
          onClick={handleDelete}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
        >
          {t("gpu.remove")}
        </button>
      </div>
    );
  }

  // State 7: GPU available, not downloaded — show banner
  if (gpuResult?.available && !dismissed) {
    return (
      <div className="mt-2 rounded-md border border-primary/20 bg-primary/5 p-2.5">
        <div className="flex items-start gap-2.5">
          <Zap size={13} className="text-primary shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground">{t("gpu.reasoningBanner")}</p>
            <div className="flex items-center gap-2 mt-1.5">
              <Button
                onClick={handleDownload}
                size="sm"
                variant="default"
                className="h-6 px-2.5 text-xs"
              >
                {t("gpu.enableButton")}
              </Button>
              <button
                onClick={() => {
                  localStorage.setItem("llamaVulkanBannerDismissed", "true");
                  setDismissed(true);
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {t("gpu.dismiss")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default function ReasoningModelSelector({
  reasoningModel,
  setReasoningModel,
  localReasoningProvider,
  setLocalReasoningProvider,
  cloudReasoningBaseUrl,
  setCloudReasoningBaseUrl,
  customReasoningApiKey = "",
  setCustomReasoningApiKey,
  setReasoningMode: setReasoningModeProp,
  mode,
}: ReasoningModelSelectorProps) {
  const { t } = useTranslation();
  const openaiApiKey = useSettingsStore((s) => s.openaiApiKey);
  const setOpenaiApiKey = useSettingsStore((s) => s.setOpenaiApiKey);
  const anthropicApiKey = useSettingsStore((s) => s.anthropicApiKey);
  const setAnthropicApiKey = useSettingsStore((s) => s.setAnthropicApiKey);
  const geminiApiKey = useSettingsStore((s) => s.geminiApiKey);
  const setGeminiApiKey = useSettingsStore((s) => s.setGeminiApiKey);
  const groqApiKey = useSettingsStore((s) => s.groqApiKey);
  const setGroqApiKey = useSettingsStore((s) => s.setGroqApiKey);
  const [selectedMode, setSelectedMode] = useState<"cloud" | "local">(mode || "cloud");
  const [selectedCloudProvider, setSelectedCloudProvider] = useState("openai");
  const [selectedLocalProvider, setSelectedLocalProvider] = useState("qwen");

  const effectiveMode = mode || selectedMode;

  const cloudProviders = CLOUD_PROVIDER_IDS.map((id) => ({
    id,
    name:
      id === "custom"
        ? t("reasoning.custom.providerName")
        : id === OPENROUTER_TAB
          ? "OpenRouter"
          : REASONING_PROVIDERS[id as keyof typeof REASONING_PROVIDERS]?.name || id,
  }));

  const localProviders = useMemo<LocalProvider[]>(() => {
    return modelRegistry.getAllProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        size: model.size,
        sizeBytes: model.sizeBytes,
        description: model.description,
        descriptionKey: model.descriptionKey,
        specUrl: model.hfRepo ? `https://huggingface.co/${model.hfRepo}` : undefined,
        recommended: model.recommended,
      })),
    }));
  }, []);

  const openaiModelOptions = useMemo<CloudModelOption[]>(() => {
    const iconUrl = getProviderIcon("openai");
    return REASONING_PROVIDERS.openai.models.map((model) => ({
      ...model,
      description: model.descriptionKey
        ? t(model.descriptionKey, { defaultValue: model.description })
        : model.description,
      icon: iconUrl,
      invertInDark: true,
    }));
  }, [t]);

  const selectedCloudModels = useMemo<CloudModelOption[]>(() => {
    if (selectedCloudProvider === "openai") return openaiModelOptions;
    if (selectedCloudProvider === "custom" || selectedCloudProvider === OPENROUTER_TAB) return [];

    const provider = REASONING_PROVIDERS[selectedCloudProvider as keyof typeof REASONING_PROVIDERS];
    if (!provider?.models) return [];

    const iconUrl = getProviderIcon(selectedCloudProvider);
    const invertInDark = isMonochromeProvider(selectedCloudProvider);
    return provider.models.map((model) => ({
      ...model,
      description: model.descriptionKey
        ? t(model.descriptionKey, { defaultValue: model.description })
        : model.description,
      icon: iconUrl,
      invertInDark,
    }));
  }, [selectedCloudProvider, openaiModelOptions, t]);

  useEffect(() => {
    const localProviderIds = localProviders.map((p) => p.id);
    if (localProviderIds.includes(localReasoningProvider)) {
      setSelectedMode("local");
      setSelectedLocalProvider(localReasoningProvider);
    } else if (CLOUD_PROVIDER_IDS.includes(localReasoningProvider)) {
      setSelectedMode("cloud");
      setSelectedCloudProvider(storedToTab(localReasoningProvider, cloudReasoningBaseUrl));
    }
  }, [localProviders, localReasoningProvider, cloudReasoningBaseUrl]);

  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(new Set());

  const loadDownloadedModels = useCallback(async () => {
    try {
      const result = await window.electronAPI?.modelGetAll?.();
      if (result && Array.isArray(result)) {
        const downloaded = new Set(
          result
            .filter((m: { isDownloaded?: boolean }) => m.isDownloaded)
            .map((m: { id: string }) => m.id)
        );
        setDownloadedModels(downloaded);
        return downloaded;
      }
    } catch (error) {
      logger.error("Failed to load downloaded models", { error }, "models");
    }
    return new Set<string>();
  }, []);

  useEffect(() => {
    loadDownloadedModels();
  }, [loadDownloadedModels]);

  const handleModeChange = async (newMode: "cloud" | "local") => {
    setSelectedMode(newMode);
    setReasoningModeProp?.(newMode === "local" ? "local" : "providers");

    if (newMode === "cloud") {
      window.electronAPI?.llamaServerStop?.();
      const { provider, baseUrl } = tabToStored(selectedCloudProvider);
      setLocalReasoningProvider(provider);
      if (baseUrl !== undefined) setCloudReasoningBaseUrl(baseUrl);

      if (provider === "custom") return;

      const providerData = REASONING_PROVIDERS[provider as keyof typeof REASONING_PROVIDERS];
      if (providerData?.models?.length > 0) {
        setReasoningModel(providerData.models[0].value);
      }
    } else {
      setLocalReasoningProvider(selectedLocalProvider);
      const downloaded = await loadDownloadedModels();
      const provider = localProviders.find((p) => p.id === selectedLocalProvider);
      const models = provider?.models ?? [];
      if (models.length > 0) {
        const firstDownloaded = models.find((m) => downloaded.has(m.id));
        if (firstDownloaded) {
          setReasoningModel(firstDownloaded.id);
        } else {
          setReasoningModel("");
        }
      }
    }
  };

  const handleCloudProviderChange = (tab: string) => {
    setSelectedCloudProvider(tab);
    const { provider, baseUrl } = tabToStored(tab);
    setLocalReasoningProvider(provider);

    if (baseUrl !== undefined) {
      setCloudReasoningBaseUrl(baseUrl);
    } else if (
      tab === "custom" &&
      normalizeBaseUrl(cloudReasoningBaseUrl) === API_ENDPOINTS.OPENROUTER_BASE
    ) {
      // Leaving OpenRouter for a generic endpoint — clear the pinned URL.
      setCloudReasoningBaseUrl(API_ENDPOINTS.OPENAI_BASE);
    }

    if (provider === "custom") return;

    const providerData = REASONING_PROVIDERS[provider as keyof typeof REASONING_PROVIDERS];
    if (providerData?.models?.length > 0) {
      setReasoningModel(providerData.models[0].value);
    }
  };

  const handleLocalProviderChange = async (providerId: string) => {
    setSelectedLocalProvider(providerId);
    setLocalReasoningProvider(providerId);
    const downloaded = await loadDownloadedModels();
    const provider = localProviders.find((p) => p.id === providerId);
    const models = provider?.models ?? [];
    if (models.length > 0) {
      const firstDownloaded = models.find((m) => downloaded.has(m.id));
      if (firstDownloaded) {
        setReasoningModel(firstDownloaded.id);
      } else {
        setReasoningModel("");
      }
    }
  };

  const MODE_TABS = [
    { id: "cloud", name: t("reasoning.mode.cloud") },
    { id: "local", name: t("reasoning.mode.local") },
  ];

  const renderModeIcon = (id: string) => {
    if (id === "cloud") return <Cloud className="w-4 h-4" />;
    return <Lock className="w-4 h-4" />;
  };

  return (
    <div className="space-y-4">
      {!mode && (
        <div className="space-y-2">
          <ProviderTabs
            providers={MODE_TABS}
            selectedId={effectiveMode}
            onSelect={(id) => handleModeChange(id as "cloud" | "local")}
            renderIcon={renderModeIcon}
            colorScheme="purple"
          />
          <p className="text-xs text-muted-foreground text-center">
            {effectiveMode === "local"
              ? t("reasoning.mode.localDescription")
              : t("reasoning.mode.cloudDescription")}
          </p>
        </div>
      )}

      {effectiveMode === "cloud" && (
        <div className="space-y-2">
          <ProviderTabs
            providers={cloudProviders}
            selectedId={selectedCloudProvider}
            onSelect={handleCloudProviderChange}
            colorScheme="purple"
            wrap
          />

          <div>
            {selectedCloudProvider === "custom" || selectedCloudProvider === OPENROUTER_TAB ? (
              <OpenAICompatiblePanel
                baseUrl={cloudReasoningBaseUrl}
                setBaseUrl={setCloudReasoningBaseUrl}
                apiKey={customReasoningApiKey}
                setApiKey={setCustomReasoningApiKey || (() => {})}
                model={reasoningModel}
                setModel={setReasoningModel}
                {...(selectedCloudProvider === OPENROUTER_TAB
                  ? { lockedBaseUrl: true, getKeyUrl: OPENROUTER_KEYS_URL }
                  : { defaultBaseUrl: API_ENDPOINTS.OPENAI_BASE })}
              />
            ) : (
              <>
                {selectedCloudProvider === "openai" && (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                      <GetApiKeyLink url="https://platform.openai.com/api-keys" />
                    </div>
                    <ApiKeyInput
                      apiKey={openaiApiKey}
                      setApiKey={setOpenaiApiKey}
                      label=""
                      helpText=""
                    />
                  </div>
                )}

                {selectedCloudProvider === "anthropic" && (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                      <GetApiKeyLink url="https://console.anthropic.com/settings/keys" />
                    </div>
                    <ApiKeyInput
                      apiKey={anthropicApiKey}
                      setApiKey={setAnthropicApiKey}
                      label=""
                      helpText=""
                    />
                  </div>
                )}

                {selectedCloudProvider === "gemini" && (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                      <GetApiKeyLink url="https://aistudio.google.com/app/api-keys" />
                    </div>
                    <ApiKeyInput
                      apiKey={geminiApiKey}
                      setApiKey={setGeminiApiKey}
                      label=""
                      helpText=""
                    />
                  </div>
                )}

                {selectedCloudProvider === "groq" && (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                      <GetApiKeyLink url="https://console.groq.com/keys" />
                    </div>
                    <ApiKeyInput
                      apiKey={groqApiKey}
                      setApiKey={setGroqApiKey}
                      label=""
                      helpText=""
                    />
                  </div>
                )}

                <div className="pt-3 space-y-2">
                  <h4 className="text-sm font-medium text-foreground">
                    {t("reasoning.selectModel")}
                  </h4>
                  <ModelCardList
                    models={selectedCloudModels}
                    selectedModel={reasoningModel}
                    onModelSelect={setReasoningModel}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {effectiveMode === "local" && (
        <>
          <LocalModelPicker
            providers={localProviders}
            selectedModel={reasoningModel}
            selectedProvider={selectedLocalProvider}
            onModelSelect={setReasoningModel}
            onProviderSelect={handleLocalProviderChange}
            modelType="llm"
            colorScheme="purple"
            onDownloadComplete={loadDownloadedModels}
          />
          <GpuStatusBadge />
        </>
      )}
    </div>
  );
}
