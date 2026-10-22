const WebSocket = require("ws");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const { buildRealtimeUrl } = require("./selfHostedRealtimeUrl");
const debugLogger = require("./debugLogger");

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
// A local server can take seconds for the last turn, so stop waits while the
// server is still sending something for it, not a fixed 3 s.
const STOP_IDLE_MS = 5000;
const STOP_MAX_MS = 30000;

const MODEL_MISSING = "selfHostedRealtimeModelMissing";

const COMPLETED = "conversation.item.input_audio_transcription.completed";
const FAILED = "conversation.item.input_audio_transcription.failed";

const createCompatibleRealtimeSocket = ({ url, apiKey }) =>
  new WebSocket(url, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {});

class OpenAICompatibleRealtimeStreaming extends OpenAIRealtimeStreaming {
  constructor(createSocketImpl = createCompatibleRealtimeSocket) {
    super();
    this.providerLabel = "OpenAI-compatible Realtime";
    this._createSocketImpl = createSocketImpl;
    this._stop = null;
    this._stopping = null;
    this._resetTurns();
  }

  // Lemonade sends no item_id on committed or completed, and closes a turn on
  // silence with speech_stopped and no committed at all. The base class tracks
  // turns by item_id and keeps one speechStartedAt slot, so it could close on
  // stop before the last turn arrived and stamp a segment with the next turn's
  // start. Every turn is queued here in order, with its own start time, and
  // stop waits until the queue drains.
  _resetTurns() {
    this._unnamedTurnCount = 0;
    this._openTurn = null;
    this._turns = [];
    this._startsById = new Map();
    // Set once the server sends committed for a turn it closed on silence.
    this._vadCommitShape = false;
  }

  _nameTurn(itemId) {
    if (itemId) return itemId;
    this._unnamedTurnCount += 1;
    return `unnamed-turn-${this._unnamedTurnCount}`;
  }

  handleMessage(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      return super.handleMessage(data);
    }
    if (!event || typeof event !== "object") return super.handleMessage(data);
    if (this._stop) this._restartStopIdle();

    let forwarded = event;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        if (event.item_id) this._startsById.set(event.item_id, Date.now());
        else this._openTurn = { startedAt: Date.now() };
        break;
      // After stop's commit is answered, speech_stopped only closes the turn
      // that commit already took.
      case "input_audio_buffer.speech_stopped":
        if (!event.item_id && !this._stop?.acked) {
          this._turns.push({ kind: "vad", id: null, startedAt: this._openTurn?.startedAt ?? null });
        }
        this._openTurn = null;
        break;
      case "input_audio_buffer.committed": {
        const id = this._nameTurn(event.item_id);
        const unbound = this._turns.find((turn) => turn.kind === "vad" && !turn.id);
        if (!this._stop || (this._vadCommitShape && unbound)) {
          if (!this._stop) this._vadCommitShape = true;
          if (unbound) unbound.id = id;
          else {
            this._turns.push({ kind: "vad", id, startedAt: this._openTurn?.startedAt ?? null });
            this._openTurn = null;
          }
        } else {
          // The answer to stop's commit, which may arrive before an earlier
          // silence-closed turn is transcribed.
          this._stop.acked = true;
          this._turns.push({ kind: "commit", id, startedAt: this._openTurn?.startedAt ?? null });
          this._openTurn = null;
        }
        forwarded = { ...event, item_id: id };
        break;
      }
      // Lemonade answers a commit with cleared, and no committed, when silence
      // already closed the last turn: nothing new is coming for the commit.
      case "input_audio_buffer.cleared":
        if (this._stop) {
          this._stop.acked = true;
          this._openTurn = null;
        }
        break;
      case COMPLETED:
      case FAILED: {
        let index = event.item_id ? this._turns.findIndex((turn) => turn.id === event.item_id) : -1;
        if (index === -1) index = this._turns.findIndex((turn) => !event.item_id || !turn.id);
        const [turn] = index === -1 ? [] : this._turns.splice(index, 1);
        // A transcript that matches no known turn while stopping is the
        // commit's own, from a server that never acks commits.
        if (!turn && this._stop) this._stop.acked = true;
        this.speechStartedAt = this._startsById.get(event.item_id) ?? turn?.startedAt ?? null;
        this._startsById.delete(event.item_id);
        if (!event.item_id && turn?.id) forwarded = { ...event, item_id: turn.id };
        break;
      }
      default:
        break;
    }

    const result = super.handleMessage(forwarded === event ? data : JSON.stringify(forwarded));
    this._checkStop();
    return result;
  }

  _checkStop() {
    if (this._stop?.acked && !this._turns.length && !this.pendingTranscriptions.size) {
      this._stop.finish();
    }
  }

  _restartStopIdle() {
    clearTimeout(this._stop.idleTimer);
    this._stop.idleTimer = setTimeout(() => this._stop?.finish("idle"), STOP_IDLE_MS);
  }

  async disconnect({ commit = true } = {}) {
    // A second call while stop is waiting shares that wait.
    if (this._stopping) return this._stopping;
    if (!commit || this.ws?.readyState !== WebSocket.OPEN || !this.audioBytesSent) {
      return super.disconnect({ commit });
    }
    this._stopping = this._commitAndDrain().finally(() => {
      this._stopping = null;
    });
    return this._stopping;
  }

  async _commitAndDrain() {
    this.isDisconnecting = true;
    const prevOnError = this.onError;
    await new Promise((resolve) => {
      const stop = { acked: false, idleTimer: null };
      const maxTimer = setTimeout(() => stop.finish("max"), STOP_MAX_MS);
      stop.finish = (timedOut) => {
        if (this._stop !== stop) return;
        clearTimeout(stop.idleTimer);
        clearTimeout(maxTimer);
        this._stop = null;
        this._onTurnSettled = null;
        this.onError = prevOnError;
        if (timedOut) {
          debugLogger.debug(
            `${this.providerLabel} stop timeout, using accumulated text`,
            this._logContext({ timeout: timedOut, turnsPending: this._turns.length })
          );
        }
        resolve();
      };
      this._stop = stop;
      this._restartStopIdle();

      // The base class's own wait would settle on its serverAcksCommits
      // shortcut; only a closed socket ends this one early.
      this._onTurnSettled = (reason) => {
        if (reason === "closed") stop.finish();
      };
      this.onError = (err) => {
        if (err?.message?.includes("buffer too small") || err?.message?.includes("commit_empty")) {
          stop.acked = true;
          this._checkStop();
        } else {
          prevOnError?.(err);
        }
      };

      try {
        this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      } catch {
        stop.finish();
      }
    });

    // The base class closes the socket, cleans up and returns the transcript.
    const result = await super.disconnect({ commit: false });
    this.isDisconnecting = false;
    return result;
  }

  async connect(options = {}) {
    const typedModel = typeof options.model === "string" ? options.model.trim() : "";
    const url = buildRealtimeUrl(options.url, typedModel);
    const apiKey = options.apiKey || "";
    // Never fall through to the base class's OpenAI default model id: these
    // servers refuse the upgrade without ?model= (Speaches) or ignore it.
    const model = typedModel || new URL(url).searchParams.get("model")?.trim();
    if (!model) throw new Error(MODEL_MISSING);
    if (!this.isConnected && !this.isConnecting) this._resetTurns();
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
