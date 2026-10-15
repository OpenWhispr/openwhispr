import type { ModelRegistryData } from "./ModelRegistry";
export type RegistrySnapshot = { data: ModelRegistryData; manifestVersion: number };
export const registryData: ModelRegistryData;
export function getRegistryData(): ModelRegistryData;
export function getRegistryVersion(): number;
export function getRegistrySnapshot(): RegistrySnapshot;
export function subscribeRegistry(listener: () => void): () => void;
export function replaceRegistryData(snapshot: RegistrySnapshot): boolean;
