import type { ModelRegistryData, ParakeetModelInfo, WhisperModelInfo } from "./ModelRegistry";
export type RegistrySnapshot = {
  data: ModelRegistryData;
  manifestVersion: number;
  pending?: boolean;
};
export type RegistrySection =
  | "cloudProviders"
  | "enterpriseProviders"
  | "transcriptionProviders"
  | "localProviders"
  | "whisperModels"
  | "parakeetModels";
export interface RetiredModel {
  id?: string;
  name: string;
  replacement?: string;
}
export const registryData: ModelRegistryData;
export function getRegistryData(): ModelRegistryData;
export function getRegistryVersion(): number;
export function getRegistrySnapshot(): RegistrySnapshot;
export function isCatalogPending(): boolean;
export function getRetiredModel(
  section: RegistrySection,
  providerId: string | undefined,
  modelId: string
): RetiredModel | undefined;
export function listRetiredModels(): Array<{
  section: RegistrySection;
  providerId: string;
  id: string;
  model: RetiredModel;
}>;
export function getRunnableSpeechModel(
  section: "whisperModels",
  modelId: string
): WhisperModelInfo | null;
export function getRunnableSpeechModel(
  section: "parakeetModels",
  modelId: string
): ParakeetModelInfo | null;
export function listRunnableLocalModels(
  section: "whisperModels" | "parakeetModels" | "localProviders"
): Array<[string, { fileName?: string }]>;
export function subscribeRegistry(listener: () => void): () => void;
export function replaceRegistryData(snapshot: RegistrySnapshot): boolean;
