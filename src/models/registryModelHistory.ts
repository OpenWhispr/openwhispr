import bundled from "./modelRegistryData.json" with { type: "json" };
import { getRegistryData, subscribeRegistry } from "./registryData.js";

const STORAGE_KEY = "publishedModelIds";
type Section = "cloudProviders" | "transcriptionProviders" | "localProviders";

function readHistory(): Set<string> {
  try {
    const values: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(values) ? values.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

// Selection history is not catalog data: it only prevents a missing cache from
// erasing a choice. It never supplies endpoints, capabilities or download URLs.
export function wasPublishedModel(section: Section, provider: string, id: string): boolean {
  return readHistory().has(JSON.stringify([section, provider, id]));
}

export function rememberPublishedModels(): () => void {
  const remember = () => {
    const history = readHistory();
    const previousSize = history.size;
    const current = getRegistryData();
    for (const section of ["cloudProviders", "transcriptionProviders", "localProviders"] as const) {
      for (const provider of current[section]) {
        const original = new Set(
          bundled[section].find((item) => item.id === provider.id)?.models.map((model) => model.id)
        );
        for (const model of provider.models) {
          if (!original.has(model.id))
            history.add(JSON.stringify([section, provider.id, model.id]));
        }
      }
    }
    if (history.size === previousSize) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...history]));
    } catch {
      // Profiles with unavailable browser storage can still use the live catalog.
    }
  };
  remember();
  return subscribeRegistry(remember);
}
