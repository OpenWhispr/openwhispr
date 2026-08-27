const CLOUD_CHAT_PROVIDERS = new Set([
  "openai",
  "groq",
  "gemini",
  "anthropic",
  "tinfoil",
  "custom",
  "openrouter",
  "corti",
]);

// Resolve Chat from Chat-owned settings only. In particular, this must never
// consult Dictation Cleanup's mode or endpoint.
export function resolveChatRoute(settings = {}) {
  const { provider, lanUrl, customApiKey, isEnterpriseProvider = false } =
    settings && typeof settings === "object" ? settings : {};

  // An explicit self-hosted URL is the caller's declared route — it wins even
  // over a stale enterprise provider id left in settings.
  const baseUrl = typeof lanUrl === "string" ? lanUrl.trim() : "";
  if (baseUrl) {
    return {
      kind: "self-hosted",
      baseUrl,
      apiKey: typeof customApiKey === "string" ? customApiKey.trim() : "",
    };
  }

  if (isEnterpriseProvider) {
    return { kind: "enterprise", baseUrl: "", apiKey: "" };
  }

  const normalizedProvider = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  if (!CLOUD_CHAT_PROVIDERS.has(normalizedProvider)) {
    return { kind: "local", baseUrl: "", apiKey: "" };
  }

  return { kind: "provider", baseUrl: "", apiKey: "" };
}
