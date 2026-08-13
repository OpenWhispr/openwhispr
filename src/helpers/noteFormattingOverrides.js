// Provider overrides for note-formatting ReasoningService.processText calls.
// Self-hosted must forward remoteUrl as lanUrl — without it, processText
// would use the dictation-cleanup scope instead of this scope's endpoint.
export function buildNoteFormattingOverrides(noteFormatting, isCloudMode) {
  if (isCloudMode) {
    return {
      inferenceScope: /** @type {const} */ ("noteFormatting"),
      provider: "openwhispr",
      baseUrl: undefined,
      customApiKey: undefined,
      lanUrl: undefined,
    };
  }

  const mode = noteFormatting?.mode;

  if (mode === "self-hosted") {
    return {
      inferenceScope: /** @type {const} */ ("noteFormatting"),
      provider: undefined,
      baseUrl: undefined,
      customApiKey: noteFormatting?.customApiKey || undefined,
      lanUrl: noteFormatting?.remoteUrl || undefined,
    };
  }

  // Local and enterprise must pin their providers too, or processText would
  // use the dictation-cleanup scope when this scope has no route override.
  const provider =
    mode === "local"
      ? "local"
      : mode === "providers" || mode === "enterprise"
        ? noteFormatting?.provider || undefined
        : undefined;
  const isCustom = provider === "custom";
  return {
    inferenceScope: /** @type {const} */ ("noteFormatting"),
    provider,
    baseUrl: isCustom ? noteFormatting?.cloudBaseUrl || undefined : undefined,
    customApiKey: isCustom ? noteFormatting?.customApiKey || undefined : undefined,
    lanUrl: undefined,
  };
}
