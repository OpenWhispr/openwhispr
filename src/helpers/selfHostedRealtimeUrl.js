const { isPrivateHost } = require("./providerConnectionTest");

// Sentinels MeetingRecordingMount translates; the resolver throws the same ones.
const URL_MISSING = "selfHostedRealtimeUrlMissing";
const URL_INVALID = "selfHostedRealtimeUrlInvalid";

// Main-process twin of isSecureWebSocketEndpoint (src/utils/urlUtils.ts), Electron-free so the
// token provider can check the URL before releasing the key. The model goes in the query:
// these servers ignore the session's model, and Speaches refuses the upgrade without it.
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
