import { useState, useEffect, useCallback } from "react";
import { ModelDefinition } from "../models/ModelRegistry";
import "../types/electron";

interface ModelWithStatus extends ModelDefinition {
  isDownloaded: boolean;
  isDownloading: boolean;
  downloadProgress: number;
}

interface LLMDownloadProgressEvent {
  modelId: string;
  progress: number;
  downloadedSize: number;
  totalSize: number;
}

export function useLocalModels() {
  const [models, setModels] = useState<ModelWithStatus[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<Map<string, LLMDownloadProgressEvent>>(new Map());

  const loadModels = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const modelsData = await window.electronAPI.modelGetAll();
      setModels(modelsData);
    } catch (err) {
      setError("Failed to load models");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();

    const handleProgress = (_event: any, data: LLMDownloadProgressEvent) => {
      setProgressMap((prev) => new Map(prev).set(data.modelId, data));
    };

    const disposeProgress = window.electronAPI.onModelDownloadProgress(handleProgress);

    return () => {
      disposeProgress?.();
    };
  }, [loadModels]);

  const downloadModel = useCallback(
    async (modelId: string) => {
      try {
        await window.electronAPI.modelDownload(modelId);
        await loadModels();
      } catch (err) {
        setError(`Failed to download model: ${(err as Error).message}`);
        throw err;
      }
    },
    [loadModels]
  );

  const deleteModel = useCallback(
    async (modelId: string) => {
      try {
        await window.electronAPI.modelDelete(modelId);
        await loadModels();
      } catch (err) {
        setError(`Failed to delete model: ${(err as Error).message}`);
        throw err;
      }
    },
    [loadModels]
  );

  const getModelProgress = useCallback(
    (modelId: string) => {
      return progressMap.get(modelId);
    },
    [progressMap]
  );

  const checkRuntimeAvailable = useCallback(async () => {
    try {
      const result = await window.electronAPI.modelCheckRuntime();
      return result;
    } catch {
      return false;
    }
  }, []);

  const modelsByProvider = models.reduce(
    (acc, model) => {
      const providerId = model.id.split("-")[0] || "other";
      if (!acc[providerId]) {
        acc[providerId] = [];
      }
      acc[providerId].push(model);
      return acc;
    },
    {} as Record<string, ModelWithStatus[]>
  );

  return {
    models,
    modelsByProvider,
    isLoading,
    error,
    downloadModel,
    deleteModel,
    getModelProgress,
    isRuntimeAvailable: checkRuntimeAvailable,
  };
}
