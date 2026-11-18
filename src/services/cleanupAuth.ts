// Pure decision for where the Custom cleanup endpoint gets its bearer from
// (Phase 5, D-04). A key the user stored always wins; with none, an endpoint on
// one of our own hosts takes the signed-in user's Titanium license (main only
// hands it out for those hosts); any other endpoint is sent no key of ours.
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
  if (storedKey && storedKey.trim()) return "stored";
  if (baseUrl && baseUrl.trim() && isTitaniumService) return "titanium";
  return "none";
}
