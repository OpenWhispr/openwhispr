function buildReasoningRequestHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function requiresReasoningApiKey(isCustomProvider, apiKey) {
  return !apiKey && !isCustomProvider;
}

function isReasoningProviderAvailable({
  reasoningProvider,
  hasOpenAI,
  hasAnthropic,
  hasGemini,
  hasGroq,
  hasLocal,
  hasCustomBaseUrl,
}) {
  switch (reasoningProvider) {
    case "anthropic":
      return !!hasAnthropic;
    case "gemini":
      return !!hasGemini;
    case "groq":
      return !!hasGroq;
    case "local":
      return !!hasLocal;
    case "custom":
      return !!hasCustomBaseUrl;
    case "openai":
    default:
      return !!hasOpenAI;
  }
}

function isTranscriptionProviderReady({
  provider,
  hasOpenAIKey,
  hasGroqKey,
  hasMistralKey,
  hasCustomBaseUrl,
}) {
  switch (provider) {
    case "groq":
      return !!hasGroqKey;
    case "mistral":
      return !!hasMistralKey;
    case "custom":
      return !!hasCustomBaseUrl;
    case "openai":
    default:
      return !!hasOpenAIKey;
  }
}

function getPersistedCustomTranscriptionBaseUrl(selectedCloudProvider, normalizedValue) {
  if (selectedCloudProvider !== "custom") return null;
  return normalizedValue;
}

export {
  buildReasoningRequestHeaders,
  requiresReasoningApiKey,
  isReasoningProviderAvailable,
  isTranscriptionProviderReady,
  getPersistedCustomTranscriptionBaseUrl,
};
