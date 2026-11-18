// STT-03: the fork default moved from the Coolify-generated hostname to a stable
// domain. Saved settings carry the old URL, so repoint them once. Pure: callers
// pass the storage in, so this is unit-testable without Electron or a DOM.
export const LEGACY_STT_HOST = "x1gsjcjrmssitgnh7hthg7nd.coolify.titaniumlabs.us";

export const STT_BASE_URL_STORAGE_KEYS = [
  "cloudTranscriptionBaseUrl",
  "meetingCloudTranscriptionBaseUrl",
  "uploadCloudTranscriptionBaseUrl",
  "remoteTranscriptionUrl",
  "meetingRemoteTranscriptionUrl",
  "uploadRemoteTranscriptionUrl",
] as const;

/** Returns `url` with the legacy host swapped for `newHost`, or null when it is not a legacy URL. */
export function migrateLegacySttUrl(
  url: string | null | undefined,
  newHost: string
): string | null {
  const trimmed = (url || "").trim();
  if (!trimmed || !newHost) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== LEGACY_STT_HOST) return null;
  parsed.hostname = newHost;
  // new URL() adds a root "/" to a bare origin; keep the user's original shape.
  const out = parsed.toString();
  return /^https?:\/\/[^/]+$/i.test(trimmed) ? out.replace(/\/$/, "") : out;
}

type StringStorage = Pick<Storage, "getItem" | "setItem">;

/** Rewrites every saved STT base URL still on the legacy host. Returns the keys changed. */
export function migrateSavedSttUrls(storage: StringStorage, defaultBaseUrl: string): string[] {
  let newHost = "";
  try {
    newHost = new URL(defaultBaseUrl).hostname;
  } catch {
    return [];
  }
  if (!newHost || newHost === LEGACY_STT_HOST) return [];
  const changed: string[] = [];
  for (const key of STT_BASE_URL_STORAGE_KEYS) {
    const next = migrateLegacySttUrl(storage.getItem(key), newHost);
    if (next !== null) {
      storage.setItem(key, next);
      changed.push(key);
    }
  }
  return changed;
}
