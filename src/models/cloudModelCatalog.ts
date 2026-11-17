import { registryData } from "./registryData.js";
import { readCachedTinfoilModels } from "./tinfoilModelCache";
import type { CloudModelDefinition, CloudProviderData } from "./ModelRegistry";

// A leaf shared with settings startup: the provider's live discovery can retire
// models without mutating the signed catalog or importing the settings store.
const cached = readCachedTinfoilModels().models;
let tinfoilOverlay: CloudModelDefinition[] | null = cached.length ? cached : null;

export function getCloudModelProviders(): CloudProviderData[] {
  return registryData.cloudProviders.map((provider) =>
    provider.id === "tinfoil" && tinfoilOverlay ? { ...provider, models: tinfoilOverlay } : provider
  );
}

export function setTinfoilModelOverlay(models: CloudModelDefinition[]): void {
  tinfoilOverlay = models;
}
