import type { ModelCapability } from "../config/inferenceScopes";

// Routers that don't answer the request they're given: `free` picks a random free
// model, `fusion` runs a panel of models with web search on the user's text, and
// `bodybuilder` writes OpenRouter API requests instead of answers.
const HIDDEN_ROUTERS = new Set(["openrouter/free", "openrouter/fusion", "openrouter/bodybuilder"]);

interface OpenRouterCatalogModel {
  id?: unknown;
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown };
}

const lists = (value: unknown, entry: string) => Array.isArray(value) && value.includes(entry);

// Whether a /models entry can serve a request that needs `needs`. Batch variants only
// answer OpenRouter's Batch API, and free variants have no zero-data-retention endpoint.
export function offersOpenRouterModel(
  model: OpenRouterCatalogModel,
  needs: readonly ModelCapability[] = []
): boolean {
  const id = String(model.id ?? "");
  if (HIDDEN_ROUTERS.has(id) || id.endsWith(":batch") || id.endsWith(":free")) return false;
  return needs.every((need) =>
    need === "tools"
      ? lists(model.supported_parameters, "tools")
      : lists(model.architecture?.input_modalities, "image")
  );
}
