import { getDictionaryHintWords } from "../utils/snippets";

export const FOURIER_MODEL = "oruk-fourier-2b";
export const FOURIER_PREFERENCE_PREFIX = "openwhispr:fourier-english:";

export function fourierPreferenceKey(config) {
  if (
    !config?.success ||
    config.managed ||
    typeof config.optionalBatchModelAccount !== "string" ||
    !config.optionalBatchModelAccount ||
    !config.optionalBatchModels?.some(
      (model) => model?.id === FOURIER_MODEL && model.languages?.includes("en")
    )
  )
    return null;
  return FOURIER_PREFERENCE_PREFIX + config.optionalBatchModelAccount;
}

// A retry or chat take is already batch. The API rechecks enrollment for its
// authenticated owner on upload, so it needs no streaming bootstrap request.
export function savedAudioFourierAccount(settings, accountId) {
  if (
    !accountId ||
    settings.useLocalWhisper ||
    settings.cloudTranscriptionMode !== "openwhispr" ||
    globalThis.localStorage?.getItem(FOURIER_PREFERENCE_PREFIX + accountId) !== "1" ||
    getDictionaryHintWords(settings).some((word) => word.trim())
  )
    return undefined;
  return accountId;
}

export function selectedFourierBatch(config, settings, language) {
  if (
    settings?.useLocalWhisper ||
    settings?.cloudTranscriptionMode !== "openwhispr" ||
    language?.toLowerCase().split(/[-_]/)[0] !== "en"
  )
    return false;
  const key = fourierPreferenceKey(config);
  return !!key && globalThis.localStorage?.getItem(key) === "1";
}
