// Build the provider overrides passed to ReasoningService.processText for a
// note-formatting action.
//
// Without this mapping, a self-hosted note-formatting config falls through to
// `provider: undefined`, and processText resolves the provider via
// getModelProvider(model) — which defaults to OpenAI. That means "Generate
// notes" silently hits api.openai.com even though the user selected a
// self-hosted endpoint. Here we forward the self-hosted URL as `lanUrl` (which
// routes processText to the "lan" provider) plus its API key.
//
// Returned shape matches the subset of ReasoningConfig the note-formatting call
// sites forward: { provider, baseUrl, customApiKey, lanUrl }.
export function buildNoteFormattingOverrides(noteFormatting, isCloudMode, customApiKey) {
  if (isCloudMode) {
    return {
      provider: "openwhispr",
      baseUrl: undefined,
      customApiKey: undefined,
      lanUrl: undefined,
    };
  }

  const mode = noteFormatting?.mode;

  // Self-hosted (OpenAI-compatible) endpoint: route via the "lan" provider so
  // the configured remoteUrl/key are used instead of the OpenAI default.
  if (mode === "self-hosted") {
    return {
      provider: undefined,
      baseUrl: undefined,
      customApiKey: customApiKey || undefined,
      lanUrl: noteFormatting?.remoteUrl || undefined,
    };
  }

  const provider = mode === "providers" ? noteFormatting?.provider || undefined : undefined;
  const isCustom = provider === "custom";
  return {
    provider,
    baseUrl: isCustom ? noteFormatting?.cloudBaseUrl || undefined : undefined,
    customApiKey: isCustom ? customApiKey || undefined : undefined,
    lanUrl: undefined,
  };
}
