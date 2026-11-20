// ESM like providerHttpErrors.js: imported by the renderer and loaded by the main
// process through require(esm). Pure on purpose (no electron, no session) so both
// sides decide the same way which URLs are Titanium services. Only a request to
// one of these hosts may ever carry the Titanium license key.

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * True when `url` points at one of our own services: the fork's default STT host
 * (DEFAULT_STT.baseUrl) or an entry of TITANIUM.serviceHosts. Exact host match
 * only, so a lookalike such as `<our host>.evil.example` is never ours.
 */
export function isTitaniumServiceUrl(url, forkConfig = {}) {
  const host = hostOf(url);
  if (!host) return false;
  const allowed = [
    hostOf(forkConfig?.DEFAULT_STT?.baseUrl),
    ...(forkConfig?.TITANIUM?.serviceHosts || []),
  ]
    .map((h) => String(h || "").toLowerCase())
    .filter(Boolean);
  return allowed.includes(host);
}
