import modelDataRaw from "./modelRegistryData.json";
import { isCloudReasoningMode, getSettings } from "../stores/settingsStore";

export interface ModelDefinition {
  id: string;
  name: string;
  size: string;
  sizeBytes: number;
  description: string;
  descriptionKey?: string;
  fileName: string;
  quantization: string;
  contextLength: number;
  hfRepo: string;
  recommended?: boolean;
}

export interface LocalProviderData {
  id: string;
  name: string;
  baseUrl: string;
  promptTemplate: string;
  models: ModelDefinition[];
}

export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: ModelDefinition[];
  formatPrompt(text: string, systemPrompt: string): string;
  getDownloadUrl(model: ModelDefinition): string;
}

export interface CloudModelDefinition {
  id: string;
  name: string;
  description: string;
  descriptionKey?: string;
  disableThinking?: boolean;
}

export interface CloudProviderData {
  id: string;
  name: string;
  models: CloudModelDefinition[];
}

export interface TranscriptionModelDefinition {
  id: string;
  name: string;
  description: string;
  descriptionKey?: string;
}

export interface TranscriptionProviderData {
  id: string;
  name: string;
  baseUrl: string;
  models: TranscriptionModelDefinition[];
}

export interface WhisperModelInfo {
  name: string;
  description: string;
  descriptionKey?: string;
  size: string;
  sizeMb: number;
  fileName: string;
  downloadUrl: string;
  recommended?: boolean;
}

export interface WhisperModelConfig {
  url: string;
  size: number;
  fileName: string;
}

export type WhisperModelsMap = Record<string, WhisperModelInfo>;

export interface ParakeetModelInfo {
  name: string;
  description: string;
  descriptionKey?: string;
  size: string;
  sizeMb: number;
  language: string;
  supportedLanguages: string[];
  recommended?: boolean;
  downloadUrl: string;
  extractDir: string;
}

export type ParakeetModelsMap = Record<string, ParakeetModelInfo>;

interface ModelRegistryData {
  parakeetModels: ParakeetModelsMap;
  whisperModels: WhisperModelsMap;
  transcriptionProviders: TranscriptionProviderData[];
  cloudProviders: CloudProviderData[];
  localProviders: LocalProviderData[];
}

const modelData: ModelRegistryData = modelDataRaw as ModelRegistryData;

function createPromptFormatter(template: string): (text: string, systemPrompt: string) => string {
  return (text: string, systemPrompt: string) => {
    return template.replace("{system}", systemPrompt).replace("{user}", text);
  };
}

class ModelRegistry {
  private static instance: ModelRegistry;
  private providers = new Map<string, ModelProvider>();

  private constructor() {
    this.registerProvidersFromData();
  }

  static getInstance(): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry();
    }
    return ModelRegistry.instance;
  }

  registerProvider(provider: ModelProvider) {
    this.providers.set(provider.id, provider);
  }

  getProvider(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }

  getAllProviders(): ModelProvider[] {
    return Array.from(this.providers.values());
  }

  getModel(modelId: string): { model: ModelDefinition; provider: ModelProvider } | undefined {
    for (const provider of this.providers.values()) {
      const model = provider.models.find((m) => m.id === modelId);
      if (model) {
        return { model, provider };
      }
    }
    return undefined;
  }

  getAllModels(): Array<ModelDefinition & { providerId: string }> {
    const models: Array<ModelDefinition & { providerId: string }> = [];
    for (const provider of this.providers.values()) {
      for (const model of provider.models) {
        models.push({ ...model, providerId: provider.id });
      }
    }
    return models;
  }

  getCloudProviders(): CloudProviderData[] {
    return modelData.cloudProviders;
  }

  getTranscriptionProviders(): TranscriptionProviderData[] {
    return modelData.transcriptionProviders;
  }

  private registerProvidersFromData() {
    const localProviders = modelData.localProviders;

    for (const providerData of localProviders) {
      const formatPrompt = createPromptFormatter(providerData.promptTemplate);

      this.registerProvider({
        id: providerData.id,
        name: providerData.name,
        baseUrl: providerData.baseUrl,
        models: providerData.models,
        formatPrompt,
        getDownloadUrl(model: ModelDefinition): string {
          return `${providerData.baseUrl}/${model.hfRepo}/resolve/main/${model.fileName}`;
        },
      });
    }
  }
}

export const modelRegistry = ModelRegistry.getInstance();

export interface ReasoningModel {
  value: string;
  label: string;
  description: string;
  descriptionKey?: string;
}

export interface ReasoningProvider {
  name: string;
  models: ReasoningModel[];
}

export type ReasoningProviders = Record<string, ReasoningProvider>;

function buildReasoningProviders(): ReasoningProviders {
  const providers: ReasoningProviders = {};

  for (const cloudProvider of modelRegistry.getCloudProviders()) {
    providers[cloudProvider.id] = {
      name: cloudProvider.name,
      models: cloudProvider.models.map((m) => ({
        value: m.id,
        label: m.name,
        description: m.description,
        descriptionKey: m.descriptionKey,
      })),
    };
  }

  providers.local = {
    name: "Local AI",
    models: modelRegistry.getAllModels().map((model) => ({
      value: model.id,
      label: model.name,
      description: `${model.description} (${model.size})`,
      descriptionKey: model.descriptionKey,
    })),
  };

  return providers;
}

export const REASONING_PROVIDERS = buildReasoningProviders();

export interface ReasoningModelWithProvider extends ReasoningModel {
  provider: string;
  fullLabel: string;
}

export function getAllReasoningModels(): ReasoningModelWithProvider[] {
  return Object.entries(REASONING_PROVIDERS).flatMap(([providerId, provider]) =>
    provider.models.map((model) => ({
      ...model,
      provider: providerId,
      fullLabel: `${provider.name} ${model.label}`,
    }))
  );
}

export function getReasoningModelLabel(modelId: string): string {
  const model = getAllReasoningModels().find((m) => m.value === modelId);
  return model?.fullLabel || modelId;
}

export function getModelProvider(modelId: string): string {
  if (isCloudReasoningMode()) {
    return "openwhispr";
  }

  if (getSettings().reasoningProvider === "custom") {
    return "custom";
  }

  const model = getAllReasoningModels().find((m) => m.value === modelId);

  if (!model) {
    if (modelId.includes("claude")) return "anthropic";
    if (modelId.includes("gemini") && !modelId.includes("gemma")) return "gemini";
    if ((modelId.includes("gpt-4") || modelId.includes("gpt-5")) && !modelId.includes("gpt-oss"))
      return "openai";
    if (
      modelId.includes("qwen/") ||
      modelId.includes("openai/") ||
      modelId.includes("llama-3.1-8b-instant") ||
      modelId.includes("llama-3.3-") ||
      modelId.includes("meta-llama/llama-4-") ||
      modelId.includes("groq/compound") ||
      modelId.includes("moonshotai/kimi-k2-")
    )
      return "groq";
    if (
      modelId.includes("qwen") ||
      modelId.includes("llama") ||
      modelId.includes("mistral") ||
      modelId.includes("gpt-oss-20b-mxfp4")
    )
      return "local";
  }

  return model?.provider || "openai";
}

export function getTranscriptionProviders(): TranscriptionProviderData[] {
  return modelRegistry.getTranscriptionProviders();
}

export function getTranscriptionProvider(
  providerId: string
): TranscriptionProviderData | undefined {
  return getTranscriptionProviders().find((p) => p.id === providerId);
}

export function getTranscriptionModels(providerId: string): TranscriptionModelDefinition[] {
  const provider = getTranscriptionProvider(providerId);
  return provider?.models || [];
}

export function getDefaultTranscriptionModel(providerId: string): string {
  const models = getTranscriptionModels(providerId);
  return models[0]?.id || "gpt-4o-mini-transcribe";
}

export function getWhisperModels(): WhisperModelsMap {
  return modelData.whisperModels;
}

export function getWhisperModelInfo(modelId: string): WhisperModelInfo | undefined {
  return modelData.whisperModels[modelId];
}

export const WHISPER_MODEL_INFO = modelData.whisperModels;

export function getCloudModel(modelId: string): CloudModelDefinition | undefined {
  for (const provider of modelData.cloudProviders) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model) return model;
  }
  return undefined;
}

export function getParakeetModels(): ParakeetModelsMap {
  return modelData.parakeetModels;
}

export function getParakeetModelInfo(modelId: string): ParakeetModelInfo | undefined {
  return modelData.parakeetModels[modelId];
}

export const PARAKEET_MODEL_INFO = modelData.parakeetModels;

export function getWhisperModelConfig(modelId: string): WhisperModelConfig | null {
  const modelInfo = modelData.whisperModels[modelId];
  if (!modelInfo) return null;
  return {
    url: modelInfo.downloadUrl,
    size: modelInfo.sizeMb * 1_000_000,
    fileName: modelInfo.fileName,
  };
}

export function getValidWhisperModelNames(): string[] {
  return Object.keys(modelData.whisperModels);
}
