// The local-model picker groups GGUF models by vendor — "llama", "qwen",
// "mistral", "gemma", "openai-oss", "liquidai" — and settings persist that
// vendor id as the scope's provider. But those are UI groupings, not inference
// providers: every local model is served by the single `local` entry in
// PROVIDER_REGISTRY.
//
// So a vendor id must be normalized before any provider lookup. Without this,
// selecting a local model for the dictation agent makes ReasoningService throw
// "Unsupported reasoning provider: llama", which callers swallow — the user
// just gets their raw transcript back with no error shown.
export function normalizeReasoningProviderId(providerId, localProviderIds = []) {
  if (!providerId) return providerId;
  return localProviderIds.includes(providerId) ? "local" : providerId;
}
