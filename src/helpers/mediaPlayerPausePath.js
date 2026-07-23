/**
 * Decide how Windows pause-on-dictation should proceed after a GSMTC probe.
 * Empty sessions only use the blind media-key toggle when mediaKeyFallback is on
 * (players like Plexamp never publish SMTC sessions). See #993.
 *
 * @param {{ status: number|null, output?: string, mediaKeyFallback?: boolean }} args
 * @returns {"gsmtc"|"fallback"|"noop"}
 */
function resolveWindowsPausePath({ status, output = "", mediaKeyFallback = false }) {
  if (status !== 0) return "fallback";
  const trimmed = String(output || "").trim();
  if (trimmed === "GSMTC_FAIL") return "fallback";
  const apps = trimmed.split("|").filter(Boolean);
  if (apps.length > 0) return "gsmtc";
  return mediaKeyFallback ? "fallback" : "noop";
}

module.exports = { resolveWindowsPausePath };
