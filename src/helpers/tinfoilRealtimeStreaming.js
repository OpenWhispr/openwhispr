const WebSocket = require("ws");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const { createTinfoilRealtimeSocket } = require("./tinfoilSecureClient");
const debugLogger = require("./debugLogger");

const TINFOIL_REALTIME_MODEL = "voxtral-mini-4b-realtime";

const COMMIT_POLL_MS = 250;
// Mirrors the silence_duration_ms the OpenAI path configures in server_vad.
const COMMIT_IDLE_MS = 600;
// Bounds the text lost on abrupt socket death and keeps segments flowing to diarization.
const MAX_UTTERANCE_MS = 30000;
const COMMIT_ACK_TIMEOUT_MS = 10000;
// Mirrors the base class's disconnect timeout so a dead server can't hang the stop.
const COMMIT_DRAIN_TIMEOUT_MS = 3000;

// Matches the empty-buffer signatures the base class tolerates at disconnect.
const isEmptyBufferError = (error) =>
  error?.code === "input_audio_buffer_commit_empty" ||
  (error?.message || "").includes("buffer too small") ||
  (error?.message || "").includes("commit_empty");

// Tinfoil's transcription intent has no server VAD, so utterance boundaries
// are decided client-side from the delta stream and committed explicitly.
class TinfoilRealtimeStreaming extends OpenAIRealtimeStreaming {
  constructor(createSocketImpl = createTinfoilRealtimeSocket) {
    super();
    this._createSocketImpl = createSocketImpl;
    this._commitTimer = null;
    this._commitInFlight = false;
    this._commitSentAt = 0;
    this._commitDrain = null;
    this._commitDrainResolve = null;
    this._lastDeltaAt = 0;
    this._emptyCommitStreak = 0;
  }

  // Audio must only ever reach the attested Tinfoil socket, so a
  // caller-supplied factory is overridden, never honored.
  async connect(options = {}) {
    const { apiKey } = options;
    const model = options.model || TINFOIL_REALTIME_MODEL;
    return super.connect({
      ...options,
      model,
      createSocket: () => this._createSocketImpl({ model, apiKey }),
    });
  }

  handleMessage(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      // Malformed frames are logged by the base handler.
      super.handleMessage(data);
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.delta") {
      // Only real text moves the idle clock; without server VAD the first delta
      // of an utterance is also the speech-start signal for mic suppression.
      if (event.delta) {
        this._lastDeltaAt = Date.now();
        if (!this.speechStartedAt) this.speechStartedAt = this._lastDeltaAt;
      }
    } else if (event.type === "conversation.item.input_audio_transcription.completed") {
      this._emptyCommitStreak = 0;
      this._settleCommit();
    } else if (event.type === "error") {
      const wasTimerCommit = this._commitInFlight;
      this._settleCommit();
      if (wasTimerCommit && isEmptyBufferError(event.error)) {
        this._handleEmptyCommitReply();
        return;
      }
    }
    super.handleMessage(data);
  }

  // An empty-buffer reply to a timer commit is benign (a lost completed or a
  // double commit); surfacing it would flash an error mid-meeting.
  _handleEmptyCommitReply() {
    this._emptyCommitStreak += 1;
    // Restart the idle window so a late completed can land before any retry.
    this._lastDeltaAt = Date.now();
    if (this._emptyCommitStreak >= 2) {
      // A second empty reply means this text can't finalize; drop it rather
      // than loop commits forever. A late completed would still deliver it.
      debugLogger.error("Tinfoil Realtime utterance could not be finalized, dropping partial", {
        partialLength: this.currentPartial.length,
      });
      this.currentPartial = "";
      this.speechStartedAt = null;
      this._emptyCommitStreak = 0;
      return;
    }
    debugLogger.debug("Tinfoil Realtime empty commit reply, awaiting late completed");
  }

  _markConnected() {
    super._markConnected();
    this._startCommitTimer();
  }

  _startCommitTimer() {
    this._stopCommitTimer();
    this._commitTimer = setInterval(() => this._commitTick(), COMMIT_POLL_MS);
  }

  _stopCommitTimer() {
    if (this._commitTimer) {
      clearInterval(this._commitTimer);
      this._commitTimer = null;
    }
  }

  _commitTick() {
    if (this.isDisconnecting || this.ws?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (this._commitInFlight) {
      // A commit the server never answered must not block the session forever.
      if (now - this._commitSentAt >= COMMIT_ACK_TIMEOUT_MS) {
        debugLogger.debug("Tinfoil Realtime commit unanswered, re-arming");
        this._settleCommit();
      }
      return;
    }
    // Committing before any delta would finalize an empty or silent buffer.
    if (!this.currentPartial) return;
    const idleFor = now - this._lastDeltaAt;
    const utteranceAge = now - (this.speechStartedAt || now);
    if (idleFor < COMMIT_IDLE_MS && utteranceAge < MAX_UTTERANCE_MS) return;
    this._commitInFlight = true;
    this._commitSentAt = now;
    this._commitDrain = new Promise((resolve) => {
      this._commitDrainResolve = resolve;
    });
    try {
      this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    } catch (err) {
      this._settleCommit();
      debugLogger.debug("Tinfoil Realtime commit send failed", { error: err.message });
    }
  }

  _settleCommit() {
    this._commitInFlight = false;
    if (this._commitDrainResolve) {
      this._commitDrainResolve();
      this._commitDrainResolve = null;
      this._commitDrain = null;
    }
  }

  // The base flush resolves on the first completed, so a commit the timer
  // already sent must finalize first or its tail transcript is lost.
  async disconnect() {
    this._stopCommitTimer();
    if (this._commitInFlight && this._commitDrain) {
      let timer;
      await Promise.race([
        this._commitDrain,
        new Promise((resolve) => {
          timer = setTimeout(resolve, COMMIT_DRAIN_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    return super.disconnect();
  }

  cleanup() {
    this._stopCommitTimer();
    this._settleCommit();
    super.cleanup();
  }
}

module.exports = { TinfoilRealtimeStreaming, TINFOIL_REALTIME_MODEL };
