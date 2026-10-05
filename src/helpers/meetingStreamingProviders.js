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
  ALLOWED_MEETING_PROVIDERS,
  getMeetingStreamingClient,
  getMeetingConnectionKey,
};
