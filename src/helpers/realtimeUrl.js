// Pure URL helpers for the realtime transcription socket. Kept free of
// electron/ws imports so it can be unit tested in plain node.

const DEFAULT_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

// Derive the realtime WebSocket URL from an OpenAI-compatible base URL, so a
// self-hosted server can serve realtime the same way it already serves
// /v1/audio/transcriptions for the batch path. Falls back to OpenAI when no
// base is configured, or when the configured value isn't a usable http(s) URL.
//
// `model` is carried in the query string for custom bases because some
// OpenAI-compatible servers require it there to open the socket, whereas
// OpenAI selects the model via session.update and keys off `intent` instead.
// Adding it only for custom bases keeps OpenAI's URL byte for byte what it was.
function realtimeUrlFromBase(baseUrl, model) {
  const base = String(baseUrl || "").trim();
  if (!base) return DEFAULT_REALTIME_URL;

  let url;
  try {
    url = new URL(base);
  } catch {
    return DEFAULT_REALTIME_URL;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return DEFAULT_REALTIME_URL;
  }

  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const path = url.pathname.replace(/\/+$/, "");
  // Tolerate a base that already points at the realtime route.
  url.pathname = /\/realtime$/i.test(path) ? path : `${path}/realtime`;
  url.searchParams.set("intent", "transcription");
  if (model) url.searchParams.set("model", model);
  return url.toString();
}

module.exports = { realtimeUrlFromBase, DEFAULT_REALTIME_URL };
