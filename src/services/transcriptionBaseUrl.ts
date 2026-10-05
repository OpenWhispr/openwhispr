// Pure BYOK base-URL resolution, kept free of registry imports so tests can
// load it standalone (see test/services/transcriptionBaseUrl.test.js).
//
// `cloudTranscriptionBaseUrl` is owned by the Custom provider tab: it is the
// only place a user-typed endpoint lives, so built-in providers must resolve
// their endpoints from the registry instead of trusting that key (#1459).
export interface TranscriptionProviderBaseUrl {
  id: string;
  baseUrl: string;
}

function parseHostname(url: string): string | null {
  for (const candidate of [url, `https://${url}`]) {
    try {
      return new URL(candidate).hostname;
    } catch {
      // fall through to the protocol-prefixed retry
    }
  }
  return null;
}

// Shared by every guard that refuses a direct Tinfoil endpoint, so the
// dictation and upload paths can't drift apart.
export const TINFOIL_PROXY_REQUIRED_ERROR =
  "Tinfoil transcription must go through the attested main-process proxy";

// True when a URL points at Tinfoil's inference host, so request paths can
// refuse a Custom base URL that targets Tinfoil directly.
export function isTinfoilInferenceUrl(
  url: string,
  providers: readonly TranscriptionProviderBaseUrl[]
): boolean {
  const tinfoilBaseUrl = providers.find((p) => p.id === "tinfoil")?.baseUrl;
  if (!tinfoilBaseUrl || !url) return false;

  const tinfoilHost = parseHostname(tinfoilBaseUrl);
  const candidateHost = parseHostname(url);
  return tinfoilHost !== null && candidateHost === tinfoilHost;
}
