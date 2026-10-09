const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const AssemblyAiStreaming = require("./assemblyAiStreaming");
const DeepgramStreaming = require("./deepgramStreaming");
const CortiStreaming = require("./cortiStreaming");
const { TinfoilRealtimeStreaming } = require("./tinfoilRealtimeStreaming");

const STREAMING_CLIENT_BY_PROVIDER = {
  "openai-realtime": OpenAIRealtimeStreaming,
  "assemblyai-realtime": AssemblyAiStreaming,
  "deepgram-realtime": DeepgramStreaming,
  "corti-realtime": CortiStreaming,
  "tinfoil-realtime": TinfoilRealtimeStreaming,
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

// A connection that authenticates with a saved key also records the count of key
// saves it opened under, so a start never reuses one opened before a save.
const getMeetingConnectionKey = (options = {}, credentialGeneration = null) =>
  JSON.stringify({
    provider: options.provider,
    model: options.model,
    language: options.language,
    mode: options.mode,
    environment: options.environment,
    tenant: options.tenant,
    keyterms: options.keyterms,
    credentialGeneration:
      options.mode === "byok" || SAVED_KEY_PROVIDERS.has(options.provider)
        ? credentialGeneration
        : null,
  });

module.exports = {
  STREAMING_CLIENT_BY_PROVIDER,
  ALLOWED_MEETING_PROVIDERS,
  getMeetingStreamingClient,
  getMeetingConnectionKey,
};
