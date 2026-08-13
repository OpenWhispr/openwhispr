import { isSelfHostedTranscription } from "./selfHostedTranscription.js";

export function shouldSkipTranscriptionApiKey(settings) {
  return isSelfHostedTranscription(settings);
}
