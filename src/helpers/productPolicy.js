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
  if (channel === "cloud-api-request") {
    let path;
    try {
      path = new URL(args[0]?.path, "https://api.example.test").pathname.replace(/\/+$/, "");
    } catch {
      return false;
    }
    const operation =
      path === "/api/reason"
        ? "cloud-reason"
        : path === "/api/agent/stream" || /^\/api\/shared\/notes\/[^/]+\/chat$/.test(path)
          ? "cloud-agent-stream-start"
          : path === "/api/agent/web-search"
            ? "agent-web-search"
            : [
                  "/api/transcribe",
                  "/api/v1/transcribe",
                  "/api/streaming-token",
                  "/api/deepgram-streaming-token",
                  "/api/gemini-live-token",
                  "/api/openai-realtime-token",
                  "/api/stt/orukeet/session",
                  "/api/stt/orukeet/pipeline-session",
                ].includes(path)
              ? "cloud-transcribe"
              : null;
    if (operation)
      return productOperationAllowed(
        snapshot,
        appVersion,
        operation,
        operation === "cloud-reason" ? [undefined, args[0]?.body] : []
      );
  }
  const requiresAgent =
    channel === "enterprise-stream-start" ||
    (channel === "cloud-reason" && args[1]?.requestPurpose === "agent") ||
    ([
      "process-local-reasoning",
      "process-anthropic-reasoning",
      "process-enterprise-reasoning",
    ].includes(channel) &&
      args[3]?.requiresAgent === true);
  if (requiresAgent && !rules.isAgentAllowed(state)) return false;
  const transcription = (selection) => rules.isTranscriptionSelectionAllowed(state, selection);
  const llm = (mode, provider = "") => rules.isLlmSelectionAllowed(state, { mode, provider });
  if (channel === "batch-transcription") return transcription(args[0]);
  if (["cloud-transcribe", "transcribe-audio-file-cloud"].includes(channel))
    return transcription({ mode: "openwhispr", provider: "" });
  if (
    [
      "transcribe-local-whisper",
      "transcribe-local-parakeet",
      "transcribe-audio-file",
      "start-dictation-preview",
    ].includes(channel)
  )
    return transcription({ mode: "local", provider: "" });
  const proxy = /^proxy-(xai|mistral|corti|tinfoil|gemini)-transcription$/.exec(channel);
  if (proxy) return transcription({ mode: "providers", provider: proxy[1] });
  if (channel === "cloud-agent-stream-start")
    return rules.isAgentAllowed(state) && llm("openwhispr");
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
  if (channel === "meeting-transcription") return transcription(realtimeSelection(args[0]));
  if (channel.startsWith("dictation-realtime-")) return transcription(realtimeSelection(args[0]));
  const stream = /^(assemblyai|deepgram|gemini|corti)-streaming-(start|warmup)$/.exec(channel);
  if (stream) {
    const options = args[0] ?? {};
    return transcription(realtimeSelection(options, `${stream[1]}-realtime`));
  }
  return true;
}

module.exports = { productOperationAllowed, productPolicyState, realtimeSelection };
