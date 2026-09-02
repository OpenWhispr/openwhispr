// Managed Azure STT shared by dictation, file upload, and history retry:
// re-validates the renderer's managed context (MANAGED_CONFIG_CHANGED on
// mismatch), mints an Entra token, and posts the audio straight to the
// workspace's Azure resource. No user-owned API key is involved.
const DEFAULT_TIMEOUT_MS = 120_000;

function createManagedTranscriptionExecutor({
  resolveEnterpriseRuntime,
  proxyFetch,
  buildUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return async function executeManagedTranscription(
    event,
    route,
    { audioBuffer, fileName, contentType, prompt }
  ) {
    if (route?.provider !== "azure" || route?.context?.inferenceScope !== "transcription") {
      throw Object.assign(new Error("Managed transcription route is invalid"), {
        code: "MANAGED_ROUTE_INVALID",
      });
    }
    const runtime = await resolveEnterpriseRuntime(event, route.provider, null, {
      managedContext: route.context,
    });
    const { azureEndpoint, azureApiVersion, managedTokenProvider } = runtime.enterprise;
    // The workspace's default deployment wins over anything the renderer sent.
    const deployment = runtime.model;
    const endpoint = await buildUrl(azureEndpoint, deployment, azureApiVersion);
    if (!endpoint) {
      throw new Error("Managed Azure transcription endpoint could not be built");
    }
    const token = await managedTokenProvider();
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer], { type: contentType }), fileName);
    formData.append("model", deployment);
    formData.append("response_format", "json");
    if (route.language && route.language !== "auto") {
      formData.append("language", route.language);
    }
    if (prompt) formData.append("prompt", prompt);
    const response = await proxyFetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`Azure transcription error: ${response.status} ${errorText}`);
      if (response.status === 429) {
        err.code = "PROVIDER_RATE_LIMITED";
        err.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
      } else if (response.status === 401 || response.status === 403) {
        err.code = "MANAGED_AUTH_REJECTED";
      } else if (response.status >= 500) {
        err.code = "SERVER_ERROR";
      }
      throw err;
    }
    const result = await response.json();
    if (typeof result?.text !== "string") {
      throw new Error("Managed transcription response was malformed");
    }
    if (!result.text.trim()) {
      throw Object.assign(new Error("No speech detected in audio"), { code: "NO_SPEECH_DETECTED" });
    }
    return result.text;
  };
}

module.exports = { createManagedTranscriptionExecutor };
