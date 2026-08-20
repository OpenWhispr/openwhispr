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

// Transcribed in the main process rather than over a realtime socket: on-device
// models, or chunked HTTP to a self-hosted OpenAI-compatible server. These have
// no streaming client by design.
const NON_STREAMING_MEETING_PROVIDERS = new Set(["local", "self-hosted"]);

// Streaming entries are derived from the registry so an allowed provider can
// never lack a client class and silently fall through to the OpenAI default.
const ALLOWED_MEETING_PROVIDERS = new Set([
  ...NON_STREAMING_MEETING_PROVIDERS,
  ...Object.keys(STREAMING_CLIENT_BY_PROVIDER),
]);

const getMeetingStreamingClient = (provider) => {
  const StreamingClient = STREAMING_CLIENT_BY_PROVIDER[provider];
  if (!StreamingClient) throw new Error(`Unsupported meeting streaming provider: ${provider}`);
  return StreamingClient;
};

const getMeetingConnectionKey = (options = {}) =>
  JSON.stringify({
    provider: options.provider,
    model: options.model,
    language: options.language,
    mode: options.mode,
    environment: options.environment,
    tenant: options.tenant,
    keyterms: options.keyterms,
  });

module.exports = {
  STREAMING_CLIENT_BY_PROVIDER,
  NON_STREAMING_MEETING_PROVIDERS,
  ALLOWED_MEETING_PROVIDERS,
  getMeetingStreamingClient,
  getMeetingConnectionKey,
};
