const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const AssemblyAiStreaming = require("./assemblyAiStreaming");
const DeepgramStreaming = require("./deepgramStreaming");
const CortiStreaming = require("./cortiStreaming");
const { TinfoilRealtimeStreaming } = require("./tinfoilRealtimeStreaming");
const SttApiStreaming = require("./sttApiStreaming");
const { createHash } = require("node:crypto");

const STREAMING_CLIENT_BY_PROVIDER = {
  "openai-realtime": OpenAIRealtimeStreaming,
  "assemblyai-realtime": AssemblyAiStreaming,
  "deepgram-realtime": DeepgramStreaming,
  "corti-realtime": CortiStreaming,
  "tinfoil-realtime": TinfoilRealtimeStreaming,
  "stt-api-realtime": SttApiStreaming,
};

// Derived from the registry so an allowed provider can never lack a client
// class and silently fall through to the OpenAI default.
const ALLOWED_MEETING_PROVIDERS = new Set(["local", ...Object.keys(STREAMING_CLIENT_BY_PROVIDER)]);

const getMeetingStreamingClient = (provider) => {
  const StreamingClient = STREAMING_CLIENT_BY_PROVIDER[provider];
  if (!StreamingClient) throw new Error(`Unsupported meeting streaming provider: ${provider}`);
  return StreamingClient;
};

// These authenticate with saved credentials whatever the mode says.
const SAVED_KEY_PROVIDERS = new Set(["corti-realtime", "tinfoil-realtime"]);

// Authenticates with the Titanium license only (see realtimeTokenProviders.js),
// never a saved BYOK key, so key saves never make its connection stale.
const LICENSE_PROVIDERS = new Set(["stt-api-realtime"]);

// Non-reversible identity of the license behind a connection: a sha256 prefix,
// never the key. Empty string when signed out, so a signed-out start can never
// match a connection opened under a license.
const licenseFingerprint = (licenseKey) =>
  licenseKey ? createHash("sha256").update(String(licenseKey)).digest("hex").slice(0, 16) : "";

// A connection that authenticates with a saved key also records the count of key
// saves it opened under, so a start never reuses one opened before a save.
// `credentialIdentity` is the license fingerprint for stt-api, so signing out or
// switching accounts makes a warm connection stale instead of silently reused.
const getMeetingConnectionKey = (
  options = {},
  credentialGeneration = null,
  credentialIdentity = null
) =>
  JSON.stringify({
    provider: options.provider,
    model: options.model,
    language: options.language,
    mode: options.mode,
    environment: options.environment,
    tenant: options.tenant,
    keyterms: options.keyterms,
    // Only stt-api sets it. The license key never enters the key (see
    // realtimeTokenProviders.js): it reaches the socket as a bearer header only.
    baseUrl: options.baseUrl,
    credentialGeneration:
      !LICENSE_PROVIDERS.has(options.provider) &&
      (options.mode === "byok" || SAVED_KEY_PROVIDERS.has(options.provider))
        ? credentialGeneration
        : null,
    credentialIdentity: LICENSE_PROVIDERS.has(options.provider) ? credentialIdentity : undefined,
  });

// True when a stored connection key belongs to stt-api and was opened under a
// different license identity than the current one (signed out or another account).
const isSttApiConnectionStale = (connectionKey, currentIdentityFor) => {
  if (!connectionKey) return false;
  let parsed;
  try {
    parsed = JSON.parse(connectionKey);
  } catch {
    return false;
  }
  if (!LICENSE_PROVIDERS.has(parsed?.provider)) return false;
  return parsed.credentialIdentity !== currentIdentityFor(parsed);
};

const isSttApiConnectionKey = (connectionKey) => {
  try {
    return LICENSE_PROVIDERS.has(JSON.parse(connectionKey)?.provider);
  } catch {
    return false;
  }
};

module.exports = {
  STREAMING_CLIENT_BY_PROVIDER,
  ALLOWED_MEETING_PROVIDERS,
  getMeetingStreamingClient,
  getMeetingConnectionKey,
  licenseFingerprint,
  isSttApiConnectionStale,
  isSttApiConnectionKey,
};
