const WebSocket = require("ws");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const { buildRealtimeUrl } = require("./selfHostedRealtimeUrl");

// Servers that speak the OpenAI Realtime transcription protocol on the user's
// own network (Lemonade, Speaches). Scoped to that protocol, not to "any URL":
// there is no HTTP fallback, so a server that never answers session.update with
// session.updated fails the connect instead of degrading.

// Lemonade and Speaches transcribe 16 kHz PCM16 and ignore the declared format
// rate, so 24 kHz meeting capture is downsampled before it is sent.
const COMPATIBLE_REALTIME_INPUT_RATE = 16000;
const DEFAULT_CAPTURE_RATE = 24000;
// The base class refuses to connect without a key; a keyless local server is
// sent no Authorization header at all, so this value never leaves the process.
const NO_API_KEY = "no-api-key";

const MODEL_MISSING = "selfHostedRealtimeModelMissing";

const createCompatibleRealtimeSocket = ({ url, apiKey }) =>
  new WebSocket(url, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {});

class OpenAICompatibleRealtimeStreaming extends OpenAIRealtimeStreaming {
  constructor(createSocketImpl = createCompatibleRealtimeSocket) {
    super();
    this.providerLabel = "OpenAI-compatible Realtime";
    this._createSocketImpl = createSocketImpl;
  }

  async connect(options = {}) {
    const typedModel = typeof options.model === "string" ? options.model.trim() : "";
    const url = buildRealtimeUrl(options.url, typedModel);
    const apiKey = options.apiKey || "";
    // Never fall through to the base class's OpenAI default model id: these
    // servers refuse the upgrade without ?model= (Speaches) or ignore it.
    const model = typedModel || new URL(url).searchParams.get("model")?.trim();
    if (!model) throw new Error(MODEL_MISSING);
    return super.connect({
      ...options,
      apiKey: apiKey || NO_API_KEY,
      model,
      // No server mints a session for us, so it is always configured here.
      preconfigured: false,
      inputRate: COMPATIBLE_REALTIME_INPUT_RATE,
      captureRate: options.captureRate || options.sampleRate || DEFAULT_CAPTURE_RATE,
      createSocket: async () => this._createSocketImpl({ url, apiKey }),
    });
  }
}

module.exports = {
  OpenAICompatibleRealtimeStreaming,
  buildRealtimeUrl,
  COMPATIBLE_REALTIME_INPUT_RATE,
};
