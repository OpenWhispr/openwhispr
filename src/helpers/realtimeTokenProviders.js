// Realtime STT token acquisition, one entry per provider. This is the explicit
// allowlist fetchRealtimeToken enforces: an unknown provider throws (fail-closed,
// #1480), and the callers that rely on it — meeting prepare/start and dictation
// streaming — resolve their provider ids in meetingTranscriptionRouting.js and
// dictationStreamingRouting.js respectively. Dependencies are injected so the
// table is unit-testable without Electron.

const dual = (streams, factory) =>
  streams === 2 ? Promise.all([factory(), factory()]) : factory();
const duplicate = (streams, value) => (streams === 2 ? [value, value] : value);

const REALTIME_TOKEN_PROVIDERS = {
  "assemblyai-realtime": async (
    { environmentManager, proxyFetch, postServerToken },
    options,
    streams
  ) => {
    if (options.mode === "byok") {
      const apiKey = environmentManager.getAssemblyAIKey();
      if (!apiKey) {
        throw new Error("No AssemblyAI API key configured. Add your key in Settings.");
      }
      return dual(streams, async () => {
        const response = await proxyFetch(
          "https://streaming.assemblyai.com/v3/token?expires_in_seconds=60",
          { headers: { Authorization: apiKey } }
        );
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || `AssemblyAI token request failed: ${response.status}`);
        }
        const data = await response.json();
        if (!data.token) throw new Error("No AssemblyAI token received");
        return data.token;
      });
    }
    return dual(streams, async () => {
      const data = await postServerToken("/api/streaming-token");
      if (!data.token) throw new Error("No AssemblyAI token received");
      return data.token;
    });
  },

  "deepgram-realtime": async ({ environmentManager, postServerToken }, options, streams) => {
    if (options.mode === "byok") {
      const apiKey = environmentManager.getDeepgramKey();
      if (!apiKey) {
        throw new Error("No Deepgram API key configured. Add your key in Settings.");
      }
      return duplicate(streams, apiKey);
    }
    return dual(streams, async () => {
      const data = await postServerToken("/api/deepgram-streaming-token");
      if (!data.token) throw new Error("No Deepgram token received");
      return data.token;
    });
  },

  "corti-realtime": async ({ mintCortiToken }, options, streams) => {
    // One token covers both meeting streams; it's only used at the WSS handshake.
    const { token } = await mintCortiToken(options);
    return duplicate(streams, token);
  },

  "tinfoil-realtime": async ({ environmentManager }, options, streams) => {
    const apiKey = environmentManager.getTinfoilKey();
    if (!apiKey) {
      const err = new Error("No Tinfoil API key configured. Add your key in Settings.");
      err.code = "NO_API";
      throw err;
    }
    return duplicate(streams, apiKey);
  },

  "openai-realtime": async ({ environmentManager, postServerToken }, options, streams) => {
    if (options.mode === "byok") {
      const apiKey = environmentManager.getOpenAIKey();
      if (!apiKey) throw new Error("No OpenAI API key configured. Add your key in Settings.");
      return duplicate(streams, apiKey);
    }
    const data = await postServerToken("/api/openai-realtime-token", {
      model: options.model,
      language: options.language,
      streams: streams || 1,
    });
    if (streams === 2) {
      if (!data.clientSecrets || data.clientSecrets.length < 2) {
        throw new Error("Expected two client secrets for dual-stream");
      }
      return data.clientSecrets;
    }
    if (!data.clientSecret) throw new Error("No client secret received");
    return data.clientSecret;
  },
};

async function fetchRealtimeTokenForProvider(provider, deps, options, { streams } = {}) {
  const acquire = REALTIME_TOKEN_PROVIDERS[provider];
  if (!acquire) {
    throw new Error(`Unsupported realtime token provider: ${provider}`);
  }
  return acquire(deps, options, streams);
}

module.exports = {
  REALTIME_TOKEN_PROVIDERS,
  fetchRealtimeTokenForProvider,
};
