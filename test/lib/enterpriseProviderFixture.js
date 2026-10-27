// Shared EnterpriseProviderConfig fixture: the settings-store credential slice
// (Bedrock / Azure / Vertex fields with setters), the ModelRegistry provider
// stub and provider icons that every Enterprise panel test mounts over.
// `storeRef` is the global bag expression the store is published to, e.g.
// "__enterprisePanels.store".
const PROVIDER_FIELDS = {
  bedrock: [
    "bedrockAuthMode",
    "bedrockRegion",
    "bedrockProfile",
    "bedrockAccessKeyId",
    "bedrockSecretAccessKey",
    "bedrockSessionToken",
  ],
  azure: ["azureEndpoint", "azureApiKey", "azureDeploymentName", "azureApiVersion"],
  vertex: ["vertexAuthMode", "vertexProject", "vertexLocation", "vertexApiKey"],
};

const DEFAULT_VALUES = {
  bedrockAuthMode: "keys",
  bedrockRegion: "us-east-1",
  bedrockProfile: "work",
  bedrockAccessKeyId: "fake-access",
  bedrockSecretAccessKey: "fake-secret",
  bedrockSessionToken: "",
  azureEndpoint: "",
  azureApiKey: "",
  azureDeploymentName: "",
  azureApiVersion: "",
  vertexAuthMode: "apikey",
  vertexProject: "",
  vertexLocation: "us-central1",
  vertexApiKey: "",
};

function enterpriseProviderMocks(
  storeRef,
  {
    values = {},
    providers = ["bedrock"],
    registry = "export const REASONING_PROVIDERS = {};",
    overrides = {},
  } = {}
) {
  const merged = { ...DEFAULT_VALUES, ...values };
  const initial = Object.fromEntries(
    providers.flatMap((provider) => PROVIDER_FIELDS[provider]).map((key) => [key, merged[key]])
  );
  return {
    "/stores/settingsStore": `
      import { create } from "zustand";
      const initial = ${JSON.stringify(initial)};
      export const useSettingsStore = create(set => ({
        ...initial,
        ...Object.fromEntries(Object.keys(initial).map(key => ["set" + key[0].toUpperCase() + key.slice(1), value => set({[key]: value})])),
      }));
      globalThis.${storeRef} = useSettingsStore;
    `,
    "/models/ModelRegistry": registry,
    "/utils/providerIcons": `export const getProviderIcon = () => ""; export const isMonochromeProvider = () => false;`,
    ...overrides,
  };
}

module.exports = { enterpriseProviderMocks };
