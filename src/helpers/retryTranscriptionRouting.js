import { buildApiUrl, normalizeBaseUrl } from "../config/constants.ts";
import { isSecureEndpoint } from "../utils/urlUtils.ts";
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
  let hasSupportedProtocol = false;
  try {
    const protocol = new URL(normalizedBaseUrl).protocol;
    hasSupportedProtocol = protocol === "http:" || protocol === "https:";
  } catch {}

  if (!normalizedBaseUrl || !hasSupportedProtocol || !isSecureEndpoint(normalizedBaseUrl)) {
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
