// Converts the Custom endpoint's stored http(s) base URL into the realtime
// WebSocket endpoint. CommonJS so both the main process (require) and the
// ESM renderer share one implementation. Rules, most specific first:
//   ws(s):// already            -> used as-is
//   path ends with /realtime    -> kept, only the query is settled
//   no path or path is /v1      -> /v1/realtime appended
//   any other path              -> /realtime appended
// The query always carries intent=transcription unless the user supplied one.

function customRealtimeSocketUrl(rawBaseUrl) {
  const trimmed = typeof rawBaseUrl === "string" ? rawBaseUrl.trim() : "";
  if (!trimmed) return null;
  let url = trimmed;
  if (/^http:\/\//i.test(url)) url = `ws://${url.slice(7)}`;
  else if (/^https:\/\//i.test(url)) url = `wss://${url.slice(8)}`;
  else if (!/^wss?:\/\//i.test(url)) return null;
  url = url.replace(/\/+$/, "");
  const queryStart = url.indexOf("?");
  let base = queryStart === -1 ? url : url.slice(0, queryStart);
  const query = queryStart === -1 ? "" : url.slice(queryStart + 1);
  const path = base.replace(/^wss?:\/\/[^/]+/, "");
  if (!/\/realtime$/i.test(base)) {
    if (!path) base += "/v1/realtime";
    else base += "/realtime";
  }
  const params = new URLSearchParams(query);
  if (!params.has("intent")) params.set("intent", "transcription");
  return `${base}?${params.toString()}`;
}

module.exports = { customRealtimeSocketUrl };
