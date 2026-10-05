import modelData from "../models/modelRegistryData.json";

const catalog = modelData.parakeetModels as Record<
  string,
  { organization?: { id: string }; modelType?: string; recommended?: boolean }
>;
// Oruk leads: it is the recommended local route, so it is the first tab everywhere.
export const LOCAL_ASR_ORGANIZATIONS = [
  { id: "oruk", name: "Oruk" },
  { id: "whisper", name: "OpenAI" },
  { id: "nvidia", name: "NVIDIA" },
  { id: "cohere", name: "Cohere" },
];

// What the local route opens on before the user has ever chosen a local model.
export const DEFAULT_LOCAL_ASR_SELECTION = {
  provider: "oruk",
  modelId:
    Object.keys(catalog).find(
      (id) => catalog[id]?.organization?.id === "oruk" && catalog[id]?.recommended
    ) ?? "",
};

export function getASRModelOrganization(modelId: string): string {
  return (
    catalog[modelId]?.organization?.id ||
    (catalog[modelId]?.modelType === "cohere-transcribe" ? "cohere" : "nvidia")
  );
}

// Organization labels are separate from the existing installation/IPC backend.
export function getSelectedASROrganization(backend: string, modelId: string): string {
  return backend === "nvidia" ? getASRModelOrganization(modelId) : backend;
}

export function usesParakeetManager(organizationId: string): boolean {
  return organizationId === "oruk" || organizationId === "nvidia" || organizationId === "cohere";
}
