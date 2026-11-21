// Pure decision for where the Custom cleanup endpoint gets its bearer from
// (Phase 5, D-04). An endpoint on one of our own hosts always takes the signed-in
// user's Titanium license (main only hands it out for those hosts), and a stored
// key is never sent there. This mirrors the STT rule (customTranscriptionKeySource
// in transcriptionAuth.js), which D-04 says cleanup follows. Any other endpoint gets
// the user's stored key, or no key of ours.
export type CleanupKeySource = "stored" | "titanium" | "none";

export function cleanupKeySource({
  storedKey,
  baseUrl,
  isTitaniumService,
}: {
  storedKey?: string | null;
  baseUrl?: string | null;
  isTitaniumService: boolean;
}): CleanupKeySource {
  if (baseUrl && baseUrl.trim() && isTitaniumService) return "titanium";
  if (storedKey && storedKey.trim()) return "stored";
  return "none";
}

/**
 * Whether to switch dictation cleanup to our own server (Phase 5, D-04). Only for
 * a user signed in to Titanium who has never configured cleanup: no stored
 * provider, endpoint, model or non-default mode, and no BYOK key of any kind. An
 * existing BYOK install keeps exactly the settings it has.
 */
export function shouldSeedSttApiCleanup({
  licensed,
  storedProvider,
  storedBaseUrl,
  storedModel,
  storedMode,
  hasByokKey,
}: {
  licensed: boolean;
  storedProvider?: string | null;
  storedBaseUrl?: string | null;
  storedModel?: string | null;
  storedMode?: string | null;
  hasByokKey: boolean;
}): boolean {
  if (!licensed || hasByokKey) return false;
  if (storedProvider || storedBaseUrl || storedModel) return false;
  return !storedMode || storedMode === "providers";
}
