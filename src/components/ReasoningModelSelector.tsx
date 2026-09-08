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
import { CircleAlert, Cloud, Lock, Zap } from "lucide-react";
import ApiKeyInput from "./ui/ApiKeyInput";
import ModelCardList from "./ui/ModelCardList";
import LocalModelPicker, { type LocalProvider } from "./LocalModelPicker";
import { ProviderTabs, type ProviderTabItem } from "./ui/ProviderTabs";
import OpenAICompatiblePanel from "./OpenAICompatiblePanel";
import { API_ENDPOINTS } from "../config/constants";
import {
  REASONING_PROVIDERS,
  toReasoningModel,
  modelRegistry,
  isProviderValidForMode,
} from "../models/ModelRegistry";
import { useTinfoilModels } from "../hooks/useTinfoilModels";
import { getRemoteProviderIcon } from "../utils/providerIcons";
import { GetApiKeyLink } from "./ui/GetApiKeyLink";
import { getCachedPlatform } from "../utils/platform";
import { useSettingsStore } from "../stores/settingsStore";
import {
  filterByokProviderOptionsByPolicy,
  isModeAllowedByPolicy,
  isProviderAllowedByPolicy,
  reconcileProviderSelection,
} from "../stores/policyRules";
import { usePolicySnapshot } from "../hooks/usePolicy";

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

const CLOUD_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  OPENROUTER_TAB,
  "tinfoil",
  "corti",
  "custom",
];

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
        <div className="mt-2 flex items-start justify-between gap-3 rounded-md border border-warning/40 bg-warning/5 p-2.5">
          <div className="flex min-w-0 items-start gap-2">
            <CircleAlert size={15} className="mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{t("gpu.activationFailed")}</p>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                {t("gpu.reasoningActivationFailedDescription")}
              </p>
              <Button
                type="button"
                onClick={handleRetry}
                size="sm"
                className="mt-2 h-7 px-3 text-xs"
              >
                {t("gpu.retryActivation")}
              </Button>
            </div>
          </div>
          <Button
            type="button"
            onClick={handleDelete}
            size="sm"
            variant="ghost"
            className="h-6 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive"
          >
            {t("gpu.remove")}
          </Button>
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
  const openrouterApiKey = useSettingsStore((s) => s.openrouterApiKey);
  const setOpenrouterApiKey = useSettingsStore((s) => s.setOpenrouterApiKey);
  const tinfoilApiKey = useSettingsStore((s) => s.tinfoilApiKey);
  const setTinfoilApiKey = useSettingsStore((s) => s.setTinfoilApiKey);
  const cortiApiKey = useSettingsStore((s) => s.cortiApiKey);
  const setCortiApiKey = useSettingsStore((s) => s.setCortiApiKey);
  const [selectedMode, setSelectedMode] = useState<"cloud" | "local">(mode || "cloud");
  const [selectedCloudProvider, setSelectedCloudProvider] = useState("openai");
  const [selectedLocalProvider, setSelectedLocalProvider] = useState("qwen");
  const policyState = usePolicySnapshot();
  const providerAllowed = useCallback(
    (providerId: string) => isProviderAllowedByPolicy(policyState, "llm", providerId),
    [policyState]
  );

  const cloudProviderTabs = useMemo(
    () =>
      filterByokProviderOptionsByPolicy(
        CLOUD_PROVIDER_IDS.map((id): ProviderTabItem => ({
          id,
          name:
            id === "custom"
              ? t("reasoning.custom.providerName")
              : id === OPENROUTER_TAB
                ? "OpenRouter"
                : REASONING_PROVIDERS[id as keyof typeof REASONING_PROVIDERS]?.name || id,
        })),
        "llm",
        policyState
      ),
    [policyState, t]
  );
  const cloudProviders = cloudProviderTabs;
  const cloudProviderFallback = reconcileProviderSelection(selectedCloudProvider, cloudProviders);
  const displayedCloudProvider = cloudProviderFallback ?? selectedCloudProvider;
  const {
    models: tinfoilModels,
    loading: tinfoilModelsLoading,
    error: tinfoilModelsError,
  } = useTinfoilModels(displayedCloudProvider === "tinfoil");
  const modeTabs = [
    ...(isModeAllowedByPolicy(policyState, "llm", "providers") && cloudProviders.length > 0
      ? [{ id: "cloud", name: t("reasoning.mode.cloud") }]
      : []),
    ...(isModeAllowedByPolicy(policyState, "llm", "local")
      ? [{ id: "local", name: t("reasoning.mode.local") }]
      : []),
  ];
  const effectiveMode =
    mode ??
    (modeTabs.some((tab) => tab.id === selectedMode)
      ? selectedMode
      : (modeTabs[0]?.id as "cloud" | "local" | undefined));

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
    const { icon, invertInDark } = getRemoteProviderIcon("openai");
    return REASONING_PROVIDERS.openai.models.map((model) => ({
      ...model,
      description: model.descriptionKey
        ? t(model.descriptionKey, { defaultValue: model.description })
        : model.description,
      icon,
      invertInDark,
    }));
  }, [t]);

  const selectedCloudModels = useMemo<CloudModelOption[]>(() => {
    if (displayedCloudProvider === "openai") return openaiModelOptions;
    if (displayedCloudProvider === "custom" || displayedCloudProvider === OPENROUTER_TAB) return [];

    const { icon: iconUrl, invertInDark } = getRemoteProviderIcon(displayedCloudProvider);

    const models =
      displayedCloudProvider === "tinfoil"
        ? tinfoilModels.map(toReasoningModel)
        : REASONING_PROVIDERS[displayedCloudProvider as keyof typeof REASONING_PROVIDERS]?.models;

    if (!models) return [];

    return models.map((model) => ({
      ...model,
      description: model.descriptionKey
        ? t(model.descriptionKey, { defaultValue: model.description })
        : model.description,
      icon: iconUrl,
      invertInDark,
    }));
  }, [displayedCloudProvider, openaiModelOptions, tinfoilModels, t]);

  useEffect(() => {
    const localProviderIds = localProviders.map((p) => p.id);
    if (localProviderIds.includes(localReasoningProvider)) {
      setSelectedMode("local");
      setSelectedLocalProvider(localReasoningProvider);
    } else if (CLOUD_PROVIDER_IDS.includes(localReasoningProvider)) {
      setSelectedMode("cloud");
      setSelectedCloudProvider(localReasoningProvider);
    }
  }, [localProviders, localReasoningProvider]);

  // A selection commits only on an explicit click: the model together with
  // the provider tab it was clicked under. Tab switching is pure browsing.
  // Local models resolve their provider from the registry so an async select
  // (e.g. a download finishing while another tab is browsed) can never commit
  // a mismatched (provider, model) pair.
  const handleModelSelect = (modelId: string) => {
    if (!modelId) {
      setReasoningModel("");
      return;
    }
    const provider =
      effectiveMode === "local"
        ? (modelRegistry.getModel(modelId)?.provider.id ?? selectedLocalProvider)
        : displayedCloudProvider;
    setLocalReasoningProvider(provider);
    setReasoningModel(modelId);
  };

  const handleModeChange = (newMode: "cloud" | "local") => {
    const policyMode = newMode === "local" ? "local" : "providers";
    if (!isModeAllowedByPolicy(policyState, "llm", policyMode)) return;
    if (newMode === "cloud" && cloudProviders.length === 0) return;
    setSelectedMode(newMode);
    const inferenceMode: InferenceMode = newMode === "local" ? "local" : "providers";
    setReasoningModeProp?.(inferenceMode);
    if (!isProviderValidForMode(localReasoningProvider, inferenceMode)) {
      setLocalReasoningProvider("");
      setReasoningModel("");
    }

    if (newMode === "cloud") {
      window.electronAPI?.llamaServerStop?.();
    }
  };

  const handleCloudProviderChange = (provider: string) => {
    if (!providerAllowed(provider)) return;
    setSelectedCloudProvider(provider);
  };

  const handleLocalProviderChange = (providerId: string) => {
    setSelectedLocalProvider(providerId);
  };

  const renderModeIcon = (id: string) => {
    if (id === "cloud") return <Cloud className="w-4 h-4" />;
    return <Lock className="w-4 h-4" />;
  };

  return (
    <div className="space-y-4">
      {!mode && (
        <div className="space-y-2">
          {modeTabs.length > 0 ? (
            <>
              <ProviderTabs
                providers={modeTabs}
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
            </>
          ) : (
            <p className="text-xs text-muted-foreground text-center">{t("common.managedByOrg")}</p>
          )}
        </div>
      )}

      {effectiveMode === "cloud" && (
        <div className="space-y-2">
          {cloudProviderTabs.length > 0 && (
            <ProviderTabs
              providers={cloudProviderTabs}
              selectedId={displayedCloudProvider}
              onSelect={handleCloudProviderChange}
              colorScheme="purple"
              wrap
            />
          )}

          {providerAllowed(displayedCloudProvider) && (
            <div>
              {/* A model renders as selected only under its committed provider —
                free-form custom/OpenRouter ids can collide with registry ids. */}
              {displayedCloudProvider === OPENROUTER_TAB ? (
                <OpenAICompatiblePanel
                  key={OPENROUTER_TAB}
                  baseUrl={API_ENDPOINTS.OPENROUTER_BASE}
                  setBaseUrl={() => {}}
                  apiKey={openrouterApiKey}
                  setApiKey={setOpenrouterApiKey}
                  model={localReasoningProvider === OPENROUTER_TAB ? reasoningModel : ""}
                  setModel={(m) => {
                    setLocalReasoningProvider(OPENROUTER_TAB);
                    setReasoningModel(m);
                  }}
                  lockedBaseUrl
                  apiKeyRequired
                  getKeyUrl={OPENROUTER_KEYS_URL}
                />
              ) : displayedCloudProvider === "custom" ? (
                <OpenAICompatiblePanel
                  key="custom"
                  baseUrl={cloudReasoningBaseUrl}
                  setBaseUrl={setCloudReasoningBaseUrl}
                  apiKey={customReasoningApiKey}
                  setApiKey={setCustomReasoningApiKey || (() => {})}
                  model={localReasoningProvider === "custom" ? reasoningModel : ""}
                  setModel={(m) => {
                    setLocalReasoningProvider("custom");
                    setReasoningModel(m);
                  }}
                  defaultBaseUrl={API_ENDPOINTS.OPENAI_BASE}
                />
              ) : (
                <>
                  {displayedCloudProvider === "openai" && (
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

                  {displayedCloudProvider === "anthropic" && (
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

                  {displayedCloudProvider === "gemini" && (
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

                  {displayedCloudProvider === "groq" && (
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

                  {displayedCloudProvider === "tinfoil" && (
                    <div className="space-y-2">
                      <div className="flex items-baseline justify-between">
                        <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                        <GetApiKeyLink url="https://tinfoil.sh/inference?utm_source=referral&utm_campaign=openwhispr" />
                      </div>
                      <ApiKeyInput
                        apiKey={tinfoilApiKey}
                        setApiKey={setTinfoilApiKey}
                        label=""
                        helpText=""
                      />
                    </div>
                  )}

                  {displayedCloudProvider === "corti" && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">{t("reasoning.corti.euOnly")}</p>
                      <div className="flex items-baseline justify-between">
                        <h4 className="font-medium text-foreground">{t("common.apiKey")}</h4>
                        <GetApiKeyLink url="https://www.corti.ai/?utm_source=referral&utm_campaign=openwhispr" />
                      </div>
                      <ApiKeyInput
                        apiKey={cortiApiKey}
                        setApiKey={setCortiApiKey}
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
                      selectedModel={
                        localReasoningProvider === displayedCloudProvider ? reasoningModel : ""
                      }
                      onModelSelect={handleModelSelect}
                    />
                    {displayedCloudProvider === "tinfoil" && (
                      <>
                        {tinfoilModelsLoading && (
                          <p className="text-xs text-muted-foreground">
                            {t("reasoning.tinfoil.refreshingModels")}
                          </p>
                        )}
                        {!tinfoilModelsLoading && tinfoilModelsError && (
                          <p className="text-xs text-destructive">
                            {t("reasoning.custom.unableToLoadModels")}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {effectiveMode === "local" && (
        <>
          <LocalModelPicker
            providers={localProviders}
            selectedModel={reasoningModel}
            selectedProvider={selectedLocalProvider}
            onModelSelect={handleModelSelect}
            onProviderSelect={handleLocalProviderChange}
            modelType="llm"
            colorScheme="purple"
          />
          <GpuStatusBadge />
        </>
      )}
    </div>
  );
}
