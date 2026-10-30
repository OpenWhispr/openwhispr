import type { ModelCapability } from "../config/inferenceScopes";

// Routers that don't answer the request they're given: `free` picks a random free
// model, `fusion` runs a panel of models with web search on the user's text, and
// `bodybuilder` writes OpenRouter API requests instead of answers.
const HIDDEN_ROUTERS = new Set(["openrouter/free", "openrouter/fusion", "openrouter/bodybuilder"]);

// Named rather than taken from list position, since the catalog is OpenRouter's. It
// supports tools and image input, so it suits every scope.
export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

// The models offered for screenshots, fastest first. Each read a test screenshot
// correctly, and the app's model list knows each can see, so a screenshot also
// reaches it when it is the assistant's main model.
export const OPENROUTER_VISION_MODELS = [
  "anthropic/claude-haiku-5.5",
  "google/gemini-3.5-flash-lite",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3-flash-preview",
  "google/gemini-3.6-flash",
  "google/gemini-3.5-flash",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-opus-4.7",
  "openai/gpt-5.6-sol",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-opus-5",
  "openai/gpt-5.5",
  "openai/gpt-6-astra",
  "anthropic/claude-opus-4.5",
  "openai/gpt-5.6-luna",
  "anthropic/claude-opus-4.6",
  "anthropic/claude-sonnet-4.5",
  "openai/gpt-4.1-mini",
  "google/gemini-4-argon",
  "openai/gpt-6.1-sol",
  "anthropic/claude-opus-5.5",
  "openai/gpt-4.1",
  "openai/gpt-5.6-terra",
  "google/gemini-3.8-flash",
  "google/gemini-3.1-pro-preview",
  "openai/gpt-5.2",
  "openai/gpt-5-nano",
];

interface OpenRouterCatalogModel {
  id?: unknown;
  supported_parameters?: unknown;
}

// Whether a /models entry can serve a request that needs `needs`. Batch variants only
// answer OpenRouter's Batch API. Free variants are left out by choice: they have no
// zero-data-retention endpoint, so they went untested. Image input is limited to the
// tested vision list.
export function offersOpenRouterModel(
  model: OpenRouterCatalogModel,
  needs: readonly ModelCapability[] = []
): boolean {
  const id = String(model.id ?? "");
  if (HIDDEN_ROUTERS.has(id) || id.endsWith(":batch") || id.endsWith(":free")) return false;
  return needs.every((need) =>
    need === "tools"
      ? Array.isArray(model.supported_parameters) && model.supported_parameters.includes("tools")
      : OPENROUTER_VISION_MODELS.includes(id)
  );
}
