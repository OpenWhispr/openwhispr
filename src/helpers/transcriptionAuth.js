import { isOrukeetEndpoint, isSelfHostedTranscription } from "./selfHostedTranscription.js";

export function shouldSkipTranscriptionApiKey(settings) {
  return isSelfHostedTranscription(settings) && !isOrukeetEndpoint(settings);
}

/**
 * Where the Custom transcription endpoint gets its bearer from. On one of our own
 * hosts the signed-in user's Titanium license key always wins and a stored custom
 * key (possibly stale from an earlier endpoint) is never sent there; anywhere else
 * only a stored key is used.
 */
export function customTranscriptionKeySource({ storedKey, isTitaniumService }) {
  if (isTitaniumService) return "titanium";
  return storedKey && String(storedKey).trim() ? "stored" : "none";
}

/**
 * A key cached for the Custom provider may be reused only off our own hosts; on them
 * the decision is made per request so a key cached from an earlier endpoint is never sent.
 */
export function canReuseCachedTranscriptionKey({ provider, isTitaniumService }) {
  return !(provider === "custom" && isTitaniumService);
}
