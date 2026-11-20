// Fork-owned (Phase 5, D-04): point dictation cleanup at our own server for users
// who are signed in to Titanium and never configured cleanup. Done as a seed on
// sign-in rather than a store default, so an existing BYOK install is untouched
// and a signed-out install keeps the upstream default.
import { FORK_DEFAULTS } from "./forkDefaults";
import { areSecretsHydrated, getSettings, useSettingsStore } from "../stores/settingsStore";
import type { ApiKeySettings } from "../hooks/useSettings";
import { shouldSeedSttApiCleanup } from "../services/cleanupAuth";
import logger from "../utils/logger";

// Every ApiKeySettings field (the compiler rejects a missing one), plus the
// per-scope custom keys and enterprise credentials that live outside it.
const API_KEY_FIELDS: Record<keyof ApiKeySettings, true> = {
  openaiApiKey: true,
  anthropicApiKey: true,
  geminiApiKey: true,
  groqApiKey: true,
  xaiApiKey: true,
  mistralApiKey: true,
  openrouterApiKey: true,
  cortiClientId: true,
  cortiClientSecret: true,
  cortiApiKey: true,
  tinfoilApiKey: true,
  deepgramApiKey: true,
  assemblyaiApiKey: true,
  customTranscriptionApiKey: true,
  cleanupCustomApiKey: true,
};
const BYOK_KEY_FIELDS = [
  ...Object.keys(API_KEY_FIELDS),
  "noteFormattingCustomApiKey",
  "translationCustomApiKey",
  "dictationAgentCustomApiKey",
  "dictationAgentVisionCustomApiKey",
  "chatAgentCustomApiKey",
  "bedrockAccessKeyId",
  "azureApiKey",
  "vertexApiKey",
];

type SeedTarget = { provider: string; baseUrl: string; model: string };

const defaultTarget = (): SeedTarget | null => {
  const { cleanupProvider, cleanupBaseUrl, cleanupModel } = FORK_DEFAULTS;
  return cleanupProvider && cleanupBaseUrl && cleanupModel
    ? { provider: cleanupProvider, baseUrl: cleanupBaseUrl, model: cleanupModel }
    : null;
};

export function seedSttApiCleanup(licensed: boolean, target: SeedTarget | null = defaultTarget()) {
  // Without hydrated secrets a BYOK user would look keyless and get seeded.
  if (!target || !areSecretsHydrated()) return false;
  const settings = getSettings() as unknown as Record<string, unknown>;
  const eligible = shouldSeedSttApiCleanup({
    licensed,
    storedProvider: localStorage.getItem("cleanupProvider"),
    storedBaseUrl: localStorage.getItem("cleanupCloudBaseUrl"),
    storedModel: localStorage.getItem("cleanupModel"),
    storedMode: localStorage.getItem("cleanupMode"),
    hasByokKey: BYOK_KEY_FIELDS.some((field) => {
      const value = settings[field];
      return typeof value === "string" && value.trim() !== "";
    }),
  });
  if (!eligible) return false;
  const store = useSettingsStore.getState();
  store.setCleanupProvider(target.provider);
  store.setCleanupCloudBaseUrl(target.baseUrl);
  store.setCleanupModel(target.model);
  logger.info("Cleanup defaulted to our server for a signed-in user", {}, "settings");
  return true;
}

let started = false;

export function startCleanupSeeding(): void {
  if (started || typeof window === "undefined" || !defaultTarget()) return;
  const api = window.electronAPI;
  if (!api?.titaniumAuthGetState) return;
  started = true;
  const apply = (state?: { licensed?: boolean } | null) => {
    if (state) seedSttApiCleanup(!!state.licensed);
  };
  void api.titaniumAuthGetState().then(apply, () => undefined);
  api.onTitaniumAuthChanged?.(apply);
}
