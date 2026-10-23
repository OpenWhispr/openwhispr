// Managed Azure STT shared by dictation, file upload, and history retry:
// re-validates the renderer's managed context (MANAGED_CONFIG_CHANGED on
// mismatch), mints an Entra token, and posts the audio straight to the
// workspace's Azure resource. No user-owned API key is involved.
const DEFAULT_TIMEOUT_MS = 120_000;
const { runAbortableOperation } = require("./enterpriseProviderErrors");

// Azure keys the accepted-format check off the multipart filename's extension
// and does not list "opus". Every .opus file is Opus in an Ogg container, so
// the .ogg name it does accept describes the same bytes.
function azureFileName(fileName) {
  return fileName.replace(/\.opus$/i, ".ogg");
}

function createManagedTranscriptionExecutor({
  resolveEnterpriseRuntime,
  proxyFetch,
  buildUrl,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  return async function executeManagedTranscription(
    event,
    route,
    { audioBuffer, fileName, contentType, prompt, signal }
  ) {
    if (
      !["azure", "openai-compatible"].includes(route?.provider) ||
      route?.context?.inferenceScope !== "transcription"
    ) {
      throw Object.assign(new Error("Managed transcription route is invalid"), {
        code: "MANAGED_ROUTE_INVALID",
        messageKey: "hooks.audioRecording.errorDescriptions.managedRouteInvalid",
      });
    }
    const runtime = await runAbortableOperation(
      () =>
        resolveEnterpriseRuntime(event, route.provider, null, {
          managedContext: route.context,
        }),
      signal
    );
    const { azureEndpoint, azureApiVersion, managedTokenProvider } = runtime.enterprise;
    const audioProfile = runtime.enterprise.audioProfile;
    // The workspace's default deployment wins over anything the renderer sent.
    const deployment = runtime.model;
    const endpoint =
      audioProfile?.endpoint ?? (await buildUrl(azureEndpoint, deployment, azureApiVersion));
    if (!endpoint) {
      throw new Error("Managed Azure transcription endpoint could not be built");
    }
    const token = audioProfile ? null : await runAbortableOperation(managedTokenProvider, signal);
    const formData = new FormData();
    formData.append(
      "file",
      new Blob([audioBuffer], { type: contentType }),
      route.provider === "azure" ? azureFileName(fileName) : fileName
    );
    formData.append("model", deployment);
    formData.append("response_format", "json");
    if (
      route.language &&
      route.language !== "auto" &&
      (!audioProfile || route.provider === "azure" || audioProfile.section.supportsLanguage)
    ) {
      formData.append("language", route.language);
    }
    if (
      prompt &&
      (!audioProfile || route.provider === "azure" || audioProfile.section.supportsPrompt)
    )
      formData.append("prompt", prompt);
    const request = {
      method: "POST",
      headers: audioProfile ? {} : { Authorization: `Bearer ${token}` },
      body: formData,
      signal: audioProfile
        ? signal
        : AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    };
    const response = audioProfile
      ? await audioProfile.request(request)
      : await proxyFetch(endpoint, request);
    if (!response.ok) {
      const err = new Error(`Enterprise transcription error: ${response.status}`);
      err.status = response.status;
      if (response.status === 429) {
        err.code = "PROVIDER_RATE_LIMITED";
        err.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
      } else if (response.status === 401 || response.status === 403) {
        err.code = "MANAGED_AUTH_REJECTED";
        err.messageKey = "hooks.audioRecording.errorDescriptions.managedAuthRejected";
      } else if (response.status >= 500) {
        err.code = "SERVER_ERROR";
      }
      throw err;
    }
    let result;
    try {
      result = await response.json();
    } catch {
      request.signal?.throwIfAborted();
      throw new Error("Managed transcription response was malformed");
    }
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
