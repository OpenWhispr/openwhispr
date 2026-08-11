import {
  resolveDictationAgentDisplayProvider,
  resolveDictationAgentProvider,
  resolveDictationAgentReachability,
} from "./dictationRouting.js";
import { isProviderValidForMode } from "../models/ModelRegistry";

// The dictation agent's inference scope, shared by the dictation route in
// audioManager and the Prompt Studio test tab so a prompt test hits the same
// provider, endpoint and credentials a real dictation does.
//
// Callers must add `systemPrompt` to the config: ReasoningService treats a
// missing one as its cleanup path, which echoes the input back instead of
// running the instruction.
export function resolveDictationAgentInference(settings, { isCloudAgent = false } = {}) {
  const model = settings.dictationAgentModel?.trim() || "";
  const isSelfHosted =
    settings.dictationAgentMode === "self-hosted" && !!settings.dictationAgentRemoteUrl?.trim();
  const storedProvider = settings.dictationAgentProvider?.trim() || "";
  const providerForMode = isProviderValidForMode(storedProvider, settings.dictationAgentMode)
    ? storedProvider
    : undefined;
  const provider = resolveDictationAgentProvider({
    isCloudAgent,
    dictationAgentMode: settings.dictationAgentMode,
    dictationAgentProvider: providerForMode,
  });
  const isCustom = settings.dictationAgentMode === "providers" && provider === "custom";

  return {
    reachable: resolveDictationAgentReachability({
      useDictationAgent: settings.useDictationAgent,
      dictationAgentMode: settings.dictationAgentMode,
      dictationAgentProvider: provider,
      dictationAgentModel: model,
      isCloudAgent,
      isSelfHostedAgent: isSelfHosted,
    }),
    model,
    displayProvider: resolveDictationAgentDisplayProvider({
      dictationAgentMode: settings.dictationAgentMode,
      dictationAgentProvider: providerForMode,
    }),
    config: {
      provider,
      lanUrl: isSelfHosted ? settings.dictationAgentRemoteUrl : undefined,
      baseUrl: isCustom ? settings.dictationAgentCloudBaseUrl || undefined : undefined,
      customApiKey:
        isCustom || isSelfHosted ? settings.dictationAgentCustomApiKey || undefined : undefined,
      disableThinking: settings.dictationAgentDisableThinking,
    },
  };
}
