const rules = require("../stores/policyRules.ts");

// A verdict still on its way for an identity nothing says is managed (no
// device policy, no server calling the policy unresolvable) restricts no
// channel; new remote work waits for it all the same (mayStart in ipcHandlers).
function productPolicyState(snapshot, appVersion) {
  return {
    status: snapshot.success
      ? snapshot.managed
        ? "managed"
        : "unmanaged"
      : snapshot.status === "loading" && snapshot.deviceReady && !snapshot.managed
        ? "unmanaged"
        : "error",
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
    const request = args[0];
    const method = (request?.method || "GET").toUpperCase();
    let path;
    try {
      path = new URL(args[0]?.path, "https://api.example.test").pathname.replace(/\/+$/, "");
    } catch {
      return false;
    }
    const share = /^\/api\/notes\/[^/]+\/(share|access)(\/.*)?$/.exec(path);
    if (share && !["GET", "DELETE"].includes(method)) {
      if (share[1] === "share" && !share[2] && method === "PATCH")
        return rules.isShareVisibilityAllowed(state, request.body?.visibility);
      if (share[1] === "access" && method === "PATCH" && request.body?.permission === "viewer")
        return true;
      if (share[2] === "/rotate-token") {
        if (args[1]?.resolvingShareVisibility)
          return (
            rules.isShareVisibilityAllowed(state, "link") ||
            rules.isShareVisibilityAllowed(state, "domain")
          );
        const visibility = args[1]?.shareVisibility;
        return (
          ["link", "domain", "invited"].includes(visibility) &&
          rules.isShareActionAllowed(state, "rotate-link", visibility)
        );
      }
      return rules.isShareActionAllowed(state, "invite", "link");
    }
    // Notes and folders also carry deliberate sharing/team work, so their
    // uploads follow the API's existing exception to the backup restriction.
    const backupOnly =
      (!["GET", "DELETE"].includes(method) &&
        (/^\/api\/(transcriptions|dictionary|snippets|conversations)\/(create|batch-create|update|messages)$/.test(
          path
        ) ||
          /^\/api\/v1\/(dictionary|snippets)\/(create|[^/]+)$/.test(path) ||
          /^\/api\/(analytics\/events\/batch|activation\/(device|batch)|product-events\/(batch|app-session))$/.test(
            path
          ))) ||
      (method === "PATCH" &&
        path === "/api/analytics/participation" &&
        request.body?.enabled === true) ||
      (method === "GET" &&
        (path === "/api/leaderboard/domain" ||
          /^\/api\/workspaces\/[^/]+\/leaderboard$/.test(path)));
    if (backupOnly && !rules.isCloudBackupAllowed(state)) return false;
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
  if (/^(gcal|mcal)-/.test(channel))
    return state.status !== "managed" || state.policy.features.connectorsEnabled !== false;
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
  // No model rides on these operations: the local model gate checks a local model.
  const transcription = (selection) =>
    selection.mode === "local"
      ? rules.isModeAllowedByPolicy(state, "transcription", "local")
      : rules.isTranscriptionSelectionAllowed(state, selection);
  const llm = (mode, provider = "") =>
    mode === "local"
      ? rules.isModeAllowedByPolicy(state, "llm", "local")
      : rules.isLlmSelectionAllowed(state, { mode, provider });
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

// Work already running ends only on a settled denial: a verdict still on its
// way for the account the work started under says nothing new about it.
function runningOperationAllowed(snapshot, accountId, appVersion, channel, args) {
  return snapshot.status === "loading"
    ? snapshot.accountId === accountId
    : productOperationAllowed(snapshot, appVersion, channel, args);
}

module.exports = {
  productOperationAllowed,
  productPolicyState,
  realtimeSelection,
  runningOperationAllowed,
};
