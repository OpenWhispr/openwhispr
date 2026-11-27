import { isOrukeetEndpoint, isSelfHostedTranscription } from "./selfHostedTranscription.js";
import { providerError, PROVIDER_ERROR_CODES } from "./providerHttpErrors.js";

// Only an intentionally blank credential permits an anonymous Custom request.
export function customTranscriptionKeyForRequest(rawKey, resolvedKey) {
  if (!resolvedKey && typeof rawKey === "string" && rawKey.trim()) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: "Custom",
      surface: "transcription",
    });
  }
  return resolvedKey;
}

export function shouldSkipTranscriptionApiKey(settings) {
  return isSelfHostedTranscription(settings) && !isOrukeetEndpoint(settings);
}
