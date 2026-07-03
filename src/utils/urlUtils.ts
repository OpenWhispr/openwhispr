function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (h === "localhost" || h === "0.0.0.0" || h.startsWith("127.")) return true;
  if (h === "::1") return true;
  if (h.startsWith("10.") || h.startsWith("192.168.")) return true;
  if (h.startsWith("172.")) {
    const octet = parseInt(h.split(".")[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(h)) return true;
  if (h.startsWith("169.254.")) return true;

  const isIPv6 = h.includes(":");
  if (isIPv6 && (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd"))) return true;
  if (h.endsWith(".local")) return true;

  return false;
}

export function isSecureEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

const AZURE_HOST_SUFFIXES = [
  ".openai.azure.com",
  ".cognitiveservices.azure.com",
  ".services.ai.azure.com",
];

// API version that supports the gpt-4o-transcribe / gpt-4o-mini-transcribe audio
// models (and remains compatible with whisper-1). Used when the user doesn't
// pin their own api-version in the endpoint URL.
export const DEFAULT_AZURE_TRANSCRIPTION_API_VERSION = "2025-03-01-preview";

export function isAzureOpenAIEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AZURE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

// Azure OpenAI doesn't expose the plain OpenAI `{base}/audio/transcriptions`
// shape — it routes by deployment in the path and requires an `api-version`
// query string. Given the user's resource endpoint and the deployment name
// (the "model" field), build the deployment-style URL Azure actually expects.
//
// If the user already pasted a full `.../audio/transcriptions` URL, it's
// respected as-is so they can pin a custom path / api-version.
export function buildAzureTranscriptionUrl(
  base: string,
  deployment: string,
  apiVersion?: string
): string | null {
  try {
    const parsed = new URL(base);
    const path = parsed.pathname.replace(/\/+$/, "");

    if (/\/audio\/(transcriptions|translations)$/i.test(path)) {
      return parsed.toString();
    }

    const name = (deployment || "").trim();
    if (!name) return null;

    const version =
      parsed.searchParams.get("api-version") ||
      (apiVersion || "").trim() ||
      DEFAULT_AZURE_TRANSCRIPTION_API_VERSION;

    return `${parsed.origin}/openai/deployments/${encodeURIComponent(
      name
    )}/audio/transcriptions?api-version=${encodeURIComponent(version)}`;
  } catch {
    return null;
  }
}
