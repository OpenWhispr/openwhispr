import type { RegistrySection } from "./registryData.js";
type ProviderList = ReadonlyArray<{
  id: string;
  defaultModel?: string;
  models: ReadonlyArray<{ id: string }>;
}>;
export function retiredReplacement(
  section: Exclude<RegistrySection, "whisperModels" | "parakeetModels">,
  providerId: string,
  modelId: string,
  providers?: ProviderList
): string | null;
export function offeredReplacement(
  section: RegistrySection,
  providerId: string,
  modelId: string,
  isOffered: (id: string) => boolean
): string | null;
export function retiredLocalSpeechReplacement(
  section: "whisperModels" | "parakeetModels",
  modelId: string
): string | null;
export function isAwaitingCatalog(
  section: Exclude<RegistrySection, "whisperModels" | "parakeetModels">,
  modelId: string,
  providers?: ProviderList
): boolean;
