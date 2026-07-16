import { useState, useEffect, useCallback, useMemo } from "react";
import { Cpu } from "lucide-react";
import { useSettingsStore } from "../../stores/settingsStore";
import LocalModelPicker, { type LocalProvider } from "../LocalModelPicker";
import { GpuModeSelector } from "../ui/GpuModeSelector";
import { modelRegistry } from "../../models/ModelRegistry";
import logger from "../../utils/logger";

export default function LocalModelSection() {
  const localModel = useSettingsStore((s) => s.localModel);
  const localProvider = useSettingsStore((s) => s.localProvider);
  const setLocalModel = useSettingsStore((s) => s.setLocalModel);
  const setLocalProvider = useSettingsStore((s) => s.setLocalProvider);

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

  const handleProviderChange = (providerId: string) => {
    setLocalProvider(providerId);
    // Do NOT auto-select a model — only the user clicking on a model changes the active model.
  };

  const activeModelInfo = useMemo(() => {
    if (!localModel) return null;
    for (const provider of localProviders) {
      const model = provider.models.find((m) => m.id === localModel);
      if (model) return { providerName: provider.name, modelName: model.name, modelSize: model.size };
    }
    return null;
  }, [localModel, localProviders]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <GpuModeSelector type="llama" />
        {activeModelInfo ? (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-sm">
            <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.7)] animate-[pulse-glow_2s_ease-in-out_infinite] shrink-0" />
            <span className="text-green-600 dark:text-green-400 font-medium">{activeModelInfo.modelName}</span>
            <span className="text-muted-foreground/60 text-xs">{activeModelInfo.providerName} · {activeModelInfo.modelSize}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted/40 border border-border/30 text-sm">
            <Cpu className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" />
            <span className="text-muted-foreground/60 text-xs">No local model selected</span>
          </div>
        )}
      </div>
      <LocalModelPicker
        providers={localProviders}
        selectedModel={localModel}
        selectedProvider={localProvider || "qwen"}
        onModelSelect={setLocalModel}
        onProviderSelect={handleProviderChange}
        modelType="llm"
        colorScheme="purple"
        onDownloadComplete={loadDownloadedModels}
      />
    </div>
  );
}
