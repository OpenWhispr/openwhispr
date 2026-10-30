import type { ModelCapability } from "../config/inferenceScopes";

// Routers that don't answer the request they're given: `free` picks a random free
// model, `fusion` runs a panel of models with web search on the user's text, and
// `bodybuilder` writes OpenRouter API requests instead of answers.
const HIDDEN_ROUTERS = new Set(["openrouter/free", "openrouter/fusion", "openrouter/bodybuilder"]);

// Named rather than taken from list position, since the catalog is OpenRouter's. It
// supports tools and image input, so it suits every scope.
export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

interface OpenRouterCatalogModel {
  id?: unknown;
  supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown };
}

const includesEntry = (value: unknown, entry: string) =>
  Array.isArray(value) && value.includes(entry);

// Whether a /models entry can serve a request that needs `needs`. Batch variants only
// answer OpenRouter's Batch API. Free variants are left out by choice: they have no
// zero-data-retention endpoint, so they went untested.
export function offersOpenRouterModel(
  model: OpenRouterCatalogModel,
  needs: readonly ModelCapability[] = []
): boolean {
  const id = String(model.id ?? "");
  if (HIDDEN_ROUTERS.has(id) || id.endsWith(":batch") || id.endsWith(":free")) return false;
  return needs.every((need) =>
    need === "tools"
      ? includesEntry(model.supported_parameters, "tools")
      : includesEntry(model.architecture?.input_modalities, "image")
  );
}
