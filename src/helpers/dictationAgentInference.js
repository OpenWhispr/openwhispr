import { resolveDictationAgentReachability } from "./dictationRouting.js";

// The dictation agent's inference scope, shared by the dictation route in
// audioManager and the Prompt Studio test tab so a prompt test hits the same
// provider, endpoint and credentials a real dictation does.
//
// Callers must add `systemPrompt` to the config: ReasoningService treats a
// missing one as its cleanup path, which echoes the input back instead of
// running the instruction.
export function resolveDictationAgentInference(settings, { isCloudAgent = false } = {}) {
  const model = settings.dictationAgentModel?.trim() || "";
  const mode = settings.dictationAgentMode;
  const isSelfHosted = mode === "self-hosted" && !!settings.dictationAgentRemoteUrl?.trim();
  // Mode wins over a leftover provider: a stale cloud id would route a local or
  // self-hosted agent request off-device. Mirrors buildNoteFormattingOverrides.
  const provider = isCloudAgent
    ? "openwhispr"
    : mode === "local"
      ? "local"
      : mode === "self-hosted"
        ? undefined
        : settings.dictationAgentProvider?.trim() || undefined;
  const isCustom = mode === "providers" && provider === "custom";

  return {
    reachable: resolveDictationAgentReachability({
      useDictationAgent: settings.useDictationAgent,
      dictationAgentModel: model,
      isCloudAgent,
      isSelfHostedAgent: isSelfHosted,
    }),
    model,
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
