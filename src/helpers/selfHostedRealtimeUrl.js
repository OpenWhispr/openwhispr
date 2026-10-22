const { isPrivateHost } = require("./providerConnectionTest");

// Sentinels MeetingRecordingMount translates; the resolver throws the same ones.
const URL_MISSING = "selfHostedRealtimeUrlMissing";
const URL_INVALID = "selfHostedRealtimeUrlInvalid";

// Main-process twin of isSecureWebSocketEndpoint in src/utils/urlUtils.ts: wss
// anywhere, cleartext ws only on a private host, so a key never crosses the
// public internet unencrypted. Kept free of Electron so the token provider can
// validate a URL before it releases the saved key. The model goes in the query
// because these servers ignore the session's transcription model (Speaches
// refuses the upgrade without it). The intent is always transcription, the
// only session this client handles; the rest of the query is kept.
function buildRealtimeUrl(url, model) {
  const raw = typeof url === "string" ? url.trim() : "";
  if (!raw) throw new Error(URL_MISSING);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(URL_INVALID);
  }
  const secure = parsed.protocol === "wss:";
  if (!secure && !(parsed.protocol === "ws:" && isPrivateHost(parsed.hostname))) {
    throw new Error(URL_INVALID);
  }

  const trimmedModel = typeof model === "string" ? model.trim() : "";
  if (trimmedModel) parsed.searchParams.set("model", trimmedModel);
  parsed.searchParams.set("intent", "transcription");
  return parsed.toString();
}

module.exports = { buildRealtimeUrl };
