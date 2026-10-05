import {
  resolveDictationTranslationReachability,
  resolveTranslationDisplayProvider,
  resolveTranslationProviderId,
} from "./dictationRouting.js";
import { isProviderValidForMode } from "../models/ModelRegistry";
import { getManagedScopeResolution } from "../stores/enterpriseIdentityStore";

// Shared by live dictation and Prompt Studio so both translation entry points
// use the same provider, endpoint, and credentials.
export function resolveDictationTranslationInference(
  settings,
  { isCloudTranslation = false } = {}
) {
  const managed = getManagedScopeResolution("dictationTranslation", settings.enterpriseSetupMode);
  if (managed.kind === "managed") {
    return {
      reachable: Boolean(
        settings.useDictationTranslation && settings.translationTargetLanguage?.trim()
      ),
      model: managed.model,
      displayProvider: managed.provider,
      config: {
        inferenceScope: /** @type {const} */ ("dictationTranslation"),
        provider: managed.provider,
        language: settings.translationTargetLanguage,
        disableThinking: settings.translationDisableThinking,
      },
    };
  }

  const mode = settings.translationMode;
  const model = settings.translationModel?.trim() || "";
  const storedProvider = settings.translationProvider?.trim() || "";
  const providerForMode = isProviderValidForMode(storedProvider, mode) ? storedProvider : undefined;
  const provider = resolveTranslationProviderId({
    isCloudTranslation,
    translationMode: mode,
    translationProvider: providerForMode,
  });
  const isSelfHosted = mode === "self-hosted" && !!settings.translationRemoteUrl?.trim();
  const isCustom = mode === "providers" && provider === "custom";

  return {
    reachable: resolveDictationTranslationReachability({
      useDictationTranslation: settings.useDictationTranslation,
      translationTargetLanguage: settings.translationTargetLanguage,
      translationMode: mode,
      translationProvider: provider,
      translationModel: model,
      isCloudTranslation,
      isSelfHostedTranslation: isSelfHosted,
    }),
    model,
    displayProvider: resolveTranslationDisplayProvider({
      translationMode: mode,
      translationProvider: providerForMode,
    }),
    config: {
      inferenceScope: /** @type {const} */ ("dictationTranslation"),
      provider,
      language: settings.translationTargetLanguage,
      lanUrl: isSelfHosted ? settings.translationRemoteUrl : undefined,
      baseUrl: isCustom ? settings.translationCloudBaseUrl || undefined : undefined,
      customApiKey:
        isCustom || isSelfHosted ? settings.translationCustomApiKey || undefined : undefined,
      disableThinking: settings.translationDisableThinking,
    },
  };
}
