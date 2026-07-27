// Builds the inference config the Prompt Studio "Test" tab uses for the
// dictation agent prompt.
//
// This mirrors the `kind === "agent"` branch of resolveReasoningRoute() in
// audioManager.js on purpose: a prompt test is only meaningful if it hits the
// same provider, endpoint and credentials a real dictation would. Keep the two
// in sync — if the agent branch there grows a field, add it here too.
//
// Note the caller must also pass `systemPrompt`. ReasoningService treats a
// missing systemPrompt as its cleanup path (wraps the input in <transcript>
// tags and pins temperature to 0), which makes the model return the input
// unchanged instead of executing the instruction under test.
export function resolveDictationAgentTestConfig(settings, { isCloudAgent = false } = {}) {
  const model = settings.dictationAgentModel?.trim() || "";
  const remoteUrl = settings.dictationAgentRemoteUrl?.trim() || "";

  const isSelfHosted = settings.dictationAgentMode === "self-hosted" && !!remoteUrl;
  const provider = isCloudAgent
    ? "openwhispr"
    : settings.dictationAgentProvider?.trim() || undefined;
  const isCustom = settings.dictationAgentMode === "providers" && provider === "custom";

  return {
    enabled: !!settings.useDictationAgent,
    // Matches resolveDictationAgentReachability: cloud and self-hosted accept an
    // empty model, every other mode requires an explicit one.
    reachable: !!settings.useDictationAgent && (isCloudAgent || isSelfHosted || model.length > 0),
    model: isCloudAgent ? settings.dictationAgentModel || "auto" : settings.dictationAgentModel,
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
