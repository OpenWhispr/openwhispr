import { modelRegistry, getWhisperModels, getParakeetModels } from "../models/ModelRegistry";
import { STREAMING_ONLY_PROVIDERS } from "./transcriptionRoute";
import type { FallbackTarget } from "./modelFallback";

export type FallbackStage = "transcription" | "cleanup";
export interface FallbackProvider {
  id: string;
  name: string;
  local?: boolean;
  customModel?: boolean;
  models: Array<{ id: string; name: string }>;
}

export function getFallbackProviders(stage: FallbackStage): FallbackProvider[] {
  if (stage === "cleanup") {
    return [
      ...modelRegistry.getCloudProviders(),
      { id: "openrouter", name: "OpenRouter", customModel: true, models: [] },
      {
        id: "local",
        name: "Local",
        local: true,
        models: modelRegistry.getAllProviders().flatMap((provider) => provider.models),
      },
    ];
  }
  return [
    ...modelRegistry
      .getTranscriptionProviders()
      .filter((provider) => !STREAMING_ONLY_PROVIDERS.has(provider.id))
      .map((provider) => ({
        ...provider,
        models: provider.batchModel
          ? [
              {
                id: provider.batchModel,
                name:
                  provider.models.find((model) => model.id === provider.batchModel)?.name ??
                  provider.batchModel,
              },
            ]
          : provider.models,
      })),
    {
      id: "whisper",
      name: "Whisper (local)",
      local: true,
      models: Object.entries(getWhisperModels()).map(([id, model]) => ({ id, name: model.name })),
    },
    ...["nvidia", "cohere"].map((provider) => ({
      id: provider,
      name: provider === "cohere" ? "Cohere (local)" : "Parakeet (local)",
      local: true,
      models: Object.entries(getParakeetModels())
        .filter(
          ([, model]) =>
            model.runtime !== "online" &&
            (model.modelType === "cohere-transcribe") === (provider === "cohere")
        )
        .map(([id, model]) => ({ id, name: model.name })),
    })),
  ].filter((provider) => provider.models.length > 0);
}

export function getFallbackProvider(
  stage: FallbackStage,
  target: FallbackTarget
): FallbackProvider | undefined {
  const provider = getFallbackProviders(stage).find((entry) => entry.id === target.provider);
  return provider &&
    (provider.customModel || provider.models.some((model) => model.id === target.model))
    ? provider
    : undefined;
}

export async function getDownloadedFallbackModels(stage: FallbackStage): Promise<Set<string>> {
  if (stage === "cleanup") {
    const models = await window.electronAPI?.modelGetAll?.();
    return new Set((models ?? []).filter((model) => model.isDownloaded).map((model) => model.id));
  }
  const [whisper, parakeet] = await Promise.all([
    window.electronAPI?.listWhisperModels?.(),
    window.electronAPI?.listParakeetModels?.(),
  ]);
  return new Set([
    ...(whisper?.success
      ? whisper.models.filter((model) => model.downloaded).map((model) => model.model)
      : []),
    ...(parakeet?.success
      ? parakeet.models.filter((model) => model.downloaded).map((model) => model.model)
      : []),
  ]);
}
