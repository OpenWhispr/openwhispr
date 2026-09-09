import modelData from "../models/modelRegistryData.json";

const catalog = modelData.parakeetModels as Record<
  string,
  { organization?: { id: string }; modelType?: string }
>;
export const LOCAL_ASR_ORGANIZATIONS = [
  { id: "oruk", name: "Oruk" },
  { id: "whisper", name: "OpenAI" },
  { id: "nvidia", name: "NVIDIA" },
  { id: "cohere", name: "Cohere" },
];

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
