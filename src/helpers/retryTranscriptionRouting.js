import { buildApiUrl, normalizeBaseUrl } from "../config/constants.ts";
import { isSecureHttpEndpoint } from "../utils/urlUtils.ts";
import { resolveSelfHostedTranscriptionModel } from "./selfHostedTranscription.js";

export function resolveSelfHostedRetryRoute(settings) {
  const mode =
    typeof settings?.transcriptionMode === "string" ? settings.transcriptionMode.trim() : "";
  if (mode !== "self-hosted") return null;

  const configuredUrl =
    typeof settings?.remoteTranscriptionUrl === "string"
      ? settings.remoteTranscriptionUrl.trim()
      : "";
  if (!configuredUrl) {
    return {
      kind: "configuration-error",
      error: "Self-hosted transcription URL is not configured",
    };
  }

  const remoteUrl = configuredUrl.replace(/\/+$/, "");
  const normalizedBaseUrl = normalizeBaseUrl(remoteUrl);
  if (!normalizedBaseUrl || !isSecureHttpEndpoint(normalizedBaseUrl)) {
    return {
      kind: "configuration-error",
      error: "Self-hosted transcription URL is invalid or unsupported",
    };
  }

  return {
    kind: "self-hosted",
    endpoint: buildApiUrl(normalizedBaseUrl, "/audio/transcriptions"),
    model: resolveSelfHostedTranscriptionModel(settings),
  };
}

export function resolveCustomTranscriptionRoute({ provider, baseUrl }) {
  if (provider !== "custom") return null;

  const configuredUrl = typeof baseUrl === "string" ? baseUrl.trim() : "";
  const normalizedBaseUrl = normalizeBaseUrl(configuredUrl);
  if (!normalizedBaseUrl || !isSecureHttpEndpoint(normalizedBaseUrl)) {
    return {
      kind: "configuration-error",
      error: "Custom transcription endpoint is invalid or unsupported",
    };
  }

  return {
    kind: "custom",
    baseUrl: normalizedBaseUrl,
    endpoint: buildApiUrl(normalizedBaseUrl, "/audio/transcriptions"),
  };
}
