// Pure URL helpers for the realtime transcription socket. Kept free of
// electron/ws imports so it can be unit tested in plain node.

const DEFAULT_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const CUSTOM_REALTIME_BASE_URL_ERROR = "Custom realtime base URL is invalid or unsupported";

function parseIPv4Literal(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;

  const ipv4 = parseIPv4Literal(h);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
  }

  if (h.includes(":") && (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd"))) {
    return true;
  }
  return h.endsWith(".local") || h.endsWith(".ts.net");
}

// Derive the realtime WebSocket URL from an OpenAI-compatible HTTP base URL.
// Absence means the built-in OpenAI endpoint. A configured-but-invalid custom
// URL fails closed: falling back to OpenAI would send audio (and potentially a
// custom credential) to the wrong provider.
function realtimeUrlFromBase(baseUrl, model) {
  const base = String(baseUrl || "").trim();
  if (!base) return DEFAULT_REALTIME_URL;

  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(CUSTOM_REALTIME_BASE_URL_ERROR);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(CUSTOM_REALTIME_BASE_URL_ERROR);
  }
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    throw new Error(CUSTOM_REALTIME_BASE_URL_ERROR);
  }

  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/realtime$/i.test(path) ? path : `${path}/realtime`;
  url.searchParams.set("intent", "transcription");
  if (model) url.searchParams.set("model", model);
  return url.toString();
}

module.exports = {
  realtimeUrlFromBase,
  DEFAULT_REALTIME_URL,
  CUSTOM_REALTIME_BASE_URL_ERROR,
};
