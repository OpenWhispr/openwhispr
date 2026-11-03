const rules = require("../stores/policyRules.ts");

function productPolicyState(snapshot, appVersion) {
  return {
    status: snapshot.success ? (snapshot.managed ? "managed" : "unmanaged") : "error",
    policy: snapshot.policy ?? null,
    appVersion,
    workspaceManaged: snapshot.workspaceManaged,
  };
}

function realtimeSelection(options = {}, provider = options.provider ?? "openai-realtime") {
  if (provider === "local") return { mode: "local", provider };
  if (provider === "enterprise-realtime")
    return { mode: "enterprise", provider: options.managedContext?.provider };
  const byok = options.mode === "byok" || ["tinfoil-realtime", "corti-realtime"].includes(provider);
  return {
    mode: byok ? "providers" : "openwhispr",
    provider: provider === "orukeet" ? "custom" : provider.replace(/-realtime$/, ""),
  };
}

function productOperationAllowed(snapshot, appVersion, channel, args = []) {
  const state = productPolicyState(snapshot, appVersion);
  if (!rules.isPolicyActionAllowed(state)) return false;
  const transcription = (selection) => rules.isTranscriptionSelectionAllowed(state, selection);
  const llm = (mode, provider = "") => rules.isLlmSelectionAllowed(state, { mode, provider });
  if (["cloud-transcribe", "transcribe-audio-file-cloud"].includes(channel))
    return transcription({ mode: "openwhispr", provider: "" });
  if (
    ["transcribe-local-whisper", "transcribe-local-parakeet", "transcribe-audio-file"].includes(
      channel
    )
  )
    return transcription({ mode: "local", provider: "" });
  if (channel === "cloud-reason") return llm("openwhispr");
  if (channel === "process-local-reasoning") return llm("local");
  if (channel === "process-anthropic-reasoning") return llm("providers", "anthropic");
  if (channel === "process-enterprise-reasoning") return llm("enterprise", args[3]?.provider);
  if (channel === "enterprise-stream-start") return llm("enterprise", args[0]?.provider);
  if (channel === "test-enterprise-connection") return llm("enterprise", args[0]);
  if (channel === "bedrock-list-models") return llm("enterprise", "bedrock");
  if (channel === "get-tinfoil-chat-models") return llm("providers", "tinfoil");
  if (channel === "agent-web-search")
    return rules.isAgentAllowed(state) && rules.isWebSearchAllowed(state);
  if (channel.startsWith("dictation-realtime-")) return transcription(realtimeSelection(args[0]));
  const stream = /^(assemblyai|deepgram|gemini|corti)-streaming-(start|warmup)$/.exec(channel);
  if (stream) {
    const options = args[0] ?? {};
    return transcription(realtimeSelection(options, `${stream[1]}-realtime`));
  }
  return true;
}

module.exports = { productOperationAllowed, productPolicyState, realtimeSelection };
