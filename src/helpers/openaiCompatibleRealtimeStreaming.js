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
    this._unnamedTurns = [];
    this._unnamedTurnCount = 0;
    this._vadTurnsInFlight = 0;
    this._settleWhenVadTurnsDrain = false;
    this._turnStartTimes = [];
  }

  // Lemonade acks a commit with input_audio_buffer.committed but no item_id,
  // then sends that turn's completed event, also without one, about half a
  // second later. The base class tracks pending turns by item_id, so it read
  // the ack as "nothing left to transcribe" and closed the socket on stop
  // before the last turn arrived, losing it. Turns are named here, in order,
  // so the base class waits for them like any other.
  handleMessage(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return super.handleMessage(data);
    }
    // The base class keeps one speechStartedAt slot, so when the next turn
    // starts before this one is transcribed (continuous speech), the segment
    // is stamped with the next turn's start and speaker labels land a turn
    // early. Keep every turn's start, in order, and give the base class the
    // matching one when its transcript arrives.
    if (event && event.type === "input_audio_buffer.speech_started") {
      this._turnStartTimes.push(Date.now());
    } else if (
      event &&
      (event.type === "conversation.item.input_audio_transcription.completed" ||
        event.type === "conversation.item.input_audio_transcription.failed")
    ) {
      const startedAt = this._turnStartTimes.shift();
      if (startedAt !== undefined) this.speechStartedAt = startedAt;
    }
    if (event && !event.item_id) {
      if (event.type === "input_audio_buffer.committed") {
        this._unnamedTurnCount += 1;
        const itemId = `unnamed-turn-${this._unnamedTurnCount}`;
        this._unnamedTurns.push(itemId);
        return super.handleMessage(JSON.stringify({ ...event, item_id: itemId }));
      }
      if (
        (event.type === "conversation.item.input_audio_transcription.completed" ||
          event.type === "conversation.item.input_audio_transcription.failed") &&
        this._unnamedTurns.length
      ) {
        return super.handleMessage(
          JSON.stringify({ ...event, item_id: this._unnamedTurns.shift() })
        );
      }
      // A turn the server closed on silence has speech_stopped but no committed.
      // Count it until its transcript arrives, so a stop does not close early.
      if (event.type === "input_audio_buffer.speech_stopped") {
        this._vadTurnsInFlight += 1;
      } else if (
        event.type === "conversation.item.input_audio_transcription.completed" ||
        event.type === "conversation.item.input_audio_transcription.failed"
      ) {
        this._vadTurnsInFlight = Math.max(0, this._vadTurnsInFlight - 1);
        const result = super.handleMessage(data);
        if (this._settleWhenVadTurnsDrain && this._vadTurnsInFlight === 0) {
          this._settleWhenVadTurnsDrain = false;
          this._onTurnSettled?.("committed");
        }
        return result;
      }
    }
    // Lemonade answers a commit with input_audio_buffer.cleared, and no
    // committed, when silence already closed the last turn. Nothing new is
    // coming for the commit, so settle once any silence-closed turn has its
    // transcript instead of waiting out the disconnect timeout.
    if (event && event.type === "input_audio_buffer.cleared") {
      const result = super.handleMessage(data);
      if (this._vadTurnsInFlight === 0) this._onTurnSettled?.("committed");
      else this._settleWhenVadTurnsDrain = true;
      return result;
    }
    return super.handleMessage(data);
  }

  async connect(options = {}) {
    const typedModel = typeof options.model === "string" ? options.model.trim() : "";
    const url = buildRealtimeUrl(options.url, typedModel);
    const apiKey = options.apiKey || "";
    // Never fall through to the base class's OpenAI default model id: these
    // servers refuse the upgrade without ?model= (Speaches) or ignore it.
    const model = typedModel || new URL(url).searchParams.get("model")?.trim();
    if (!model) throw new Error(MODEL_MISSING);
    this._unnamedTurns = [];
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
