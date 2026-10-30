import type { ModelCapability } from "../config/inferenceScopes";

// Named rather than taken from a list's first entry: it is on both tested lists, so
// it suits every scope.
export const OPENROUTER_DEFAULT_MODEL = "anthropic/claude-haiku-5.5";

// The models offered for text features, fastest cleanup first. Each passed cleanup,
// translation, note formatting and a chat that calls a tool.
export const OPENROUTER_TEXT_MODELS = [
  "deepseek/deepseek-v4.1-flash",
  "anthropic/claude-haiku-4.5",
  "z-ai/glm-5.3-flash",
  "minimax/minimax-m3.1-flash",
  "openai/gpt-4.1",
  "anthropic/claude-opus-4.7",
  "xiaomi/mimo-v2.6-flash",
  "openai/gpt-5.2",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-5.5",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.5",
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-4.1-mini",
  "google/gemini-3-flash-preview",
  "openai/gpt-5.6-sol",
  "anthropic/claude-opus-4.8",
  "openai/gpt-5.6-luna",
  "openai/gpt-6-luna",
  "anthropic/claude-opus-4.6",
  "google/gemini-3.5-flash-lite",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-haiku-5.5",
  "google/gemini-3.1-flash-lite",
  "anthropic/claude-opus-4.5",
  "openai/gpt-6-astra",
  "openai/gpt-6.1-sol",
  "google/gemini-3.8-flash",
  "google/gemini-4-argon",
];

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

// The tested list a scope with `needs` offers, in the order it is shown.
export const openRouterModelList = (needs: readonly ModelCapability[] = []) =>
  needs.includes("image") ? OPENROUTER_VISION_MODELS : OPENROUTER_TEXT_MODELS;

// Whether a /models entry is offered to a scope with `needs`: it is on that scope's
// tested list, and still lists tool support where the scope sends tools.
export function offersOpenRouterModel(
  model: OpenRouterCatalogModel,
  needs: readonly ModelCapability[] = []
): boolean {
  const supportsTools =
    Array.isArray(model.supported_parameters) && model.supported_parameters.includes("tools");
  return (
    openRouterModelList(needs).includes(String(model.id ?? "")) &&
    (!needs.includes("tools") || supportsTools)
  );
}
