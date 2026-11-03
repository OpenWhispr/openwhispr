import type { ModelRegistryData } from "./ModelRegistry";
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
export function subscribeRegistry(listener: () => void): () => void;
export function replaceRegistryData(snapshot: RegistrySnapshot): boolean;
