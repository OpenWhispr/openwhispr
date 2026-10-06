const WebSocket = require("ws");
const OpenAIRealtimeStreaming = require("./openaiRealtimeStreaming");
const { createTinfoilRealtimeSocket } = require("./tinfoilSecureClient");
const debugLogger = require("./debugLogger");

const TINFOIL_REALTIME_MODEL = "voxtral-mini-4b-realtime";
const COMMIT_POLL_MS = 250;
const COMMIT_IDLE_MS = 600;
const MAX_TURN_MS = 30000;
const COMMIT_ACK_TIMEOUT_MS = 20000;
const COMMIT_DRAIN_TIMEOUT_MS = 3000;
const SPEECH_RMS_THRESHOLD = 0.003;
const SPEECH_PEAK_THRESHOLD = 0.02;

const isEmptyBufferError = (error) =>
  error?.code === "input_audio_buffer_commit_empty" ||
  (error?.message || "").includes("buffer too small") ||
  (error?.message || "").includes("commit_empty");

const hasSpeechEnergy = (pcmBuffer) => {
  if (!pcmBuffer?.length) return false;
  const samples = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    Math.floor(pcmBuffer.byteLength / 2)
  );
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] / 0x7fff;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return (
    Math.sqrt(sumSquares / samples.length) >= SPEECH_RMS_THRESHOLD && peak >= SPEECH_PEAK_THRESHOLD
  );
};

class TinfoilRealtimeStreaming extends OpenAIRealtimeStreaming {
  constructor(createSocketImpl = createTinfoilRealtimeSocket) {
    super();
    this.providerLabel = "Tinfoil Realtime";
    this._createSocketImpl = createSocketImpl;
    this._commitTimer = null;
    this._commitInFlight = false;
    this._commitSentAt = 0;
    this._commitDrain = null;
    this._commitDrainResolve = null;
    this._turnStartedAt = 0;
    this._lastSpeechAt = 0;
    this._turnSpeechStartedAt = 0;
    this._turnHasAudio = false;
    this._recoveryRequested = false;
  }

  async connect(options = {}) {
    const { apiKey } = options;
    const model = options.model || TINFOIL_REALTIME_MODEL;
    return super.connect({
      ...options,
      model,
      createSocket: () => this._createSocketImpl({ model, apiKey }),
    });
  }

  sendAudio(pcmBuffer) {
    const buffer = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
    const accepted = super.sendAudio(buffer);
    if ((!accepted && !this.bufferingAudio) || !buffer.length) return accepted;

    const now = Date.now();
    this._turnHasAudio = true;
    if (!this._turnStartedAt) this._turnStartedAt = now;
    if (hasSpeechEnergy(buffer)) {
      this._lastSpeechAt = now;
      if (!this._turnSpeechStartedAt) this._turnSpeechStartedAt = now;
      if (!this._commitInFlight && !this.speechStartedAt) {
        this.speechStartedAt = this._turnSpeechStartedAt;
      }
    }
    return accepted;
  }

  handleMessage(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
    } catch {
      super.handleMessage(data);
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const nextTurnSpeechStartedAt = this._turnSpeechStartedAt;
      this._recoveryRequested = false;
      this._settleCommit();
      super.handleMessage(data);
      if (nextTurnSpeechStartedAt && !this.speechStartedAt) {
        this.speechStartedAt = nextTurnSpeechStartedAt;
      }
      return;
    }

    if (event.type === "error" && this._commitInFlight) {
      const error = event.error || {};
      this._settleCommit();
      if (isEmptyBufferError(error)) {
        this.currentPartial = "";
        this.speechStartedAt = this._turnSpeechStartedAt || null;
        return;
      }
      super.handleMessage(data);
      this._requestRecovery(new Error(error.message || "Tinfoil commit failed"), false);
      return;
    }

    super.handleMessage(data);
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
    if (!this._commitTimer) return;
    clearInterval(this._commitTimer);
    this._commitTimer = null;
  }

  _commitTick() {
    if (this.isDisconnecting || this.ws?.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    if (this._commitInFlight) {
      if (now - this._commitSentAt >= COMMIT_ACK_TIMEOUT_MS) {
        this._requestRecovery(new Error("Tinfoil did not finish the current transcript segment."));
      }
      return;
    }
    if (!this._turnHasAudio) return;

    const turnAge = now - this._turnStartedAt;
    const speechEnded = this._lastSpeechAt > 0 && now - this._lastSpeechAt >= COMMIT_IDLE_MS;
    if (!speechEnded && turnAge < MAX_TURN_MS) return;
    this._sendCommit();
  }

  _sendCommit() {
    if (this._commitInFlight || !this._turnHasAudio || this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }

    this._commitInFlight = true;
    this._commitSentAt = Date.now();
    this._commitDrain = new Promise((resolve) => {
      this._commitDrainResolve = resolve;
    });
    try {
      this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      this._resetTurn();
      return true;
    } catch (error) {
      this._settleCommit();
      debugLogger.debug(
        `${this.providerLabel} commit send failed`,
        this._logContext({ error: error.message })
      );
      return false;
    }
  }

  _requestRecovery(error, surfaceError = true) {
    if (this._recoveryRequested) return;
    this._recoveryRequested = true;
    debugLogger.warn(
      `${this.providerLabel} connection recovery requested`,
      this._logContext({
        error: error.message,
      })
    );
    if (this.onConnectionLost) {
      this._notifyConnectionLost(error);
    } else if (surfaceError) {
      this.onError?.(error);
    }
  }

  _resetTurn() {
    this._turnStartedAt = 0;
    this._lastSpeechAt = 0;
    this._turnSpeechStartedAt = 0;
    this._turnHasAudio = false;
  }

  _settleCommit() {
    this._commitInFlight = false;
    this._commitSentAt = 0;
    this._commitDrainResolve?.();
    this._commitDrainResolve = null;
    this._commitDrain = null;
  }

  async disconnect() {
    this._stopCommitTimer();
    const deadline = Date.now() + COMMIT_DRAIN_TIMEOUT_MS;
    if (!(await this._waitForCommitDrain(deadline))) {
      return super.disconnect({ commit: false });
    }
    if (!this._commitInFlight) this._sendCommit();
    await this._waitForCommitDrain(deadline);
    return super.disconnect({ commit: false });
  }

  async _waitForCommitDrain(deadline) {
    if (!this._commitInFlight || !this._commitDrain) return true;
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining === 0) return false;
    let timeout;
    const drained = await Promise.race([
      this._commitDrain.then(() => true),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), remaining);
      }),
    ]);
    clearTimeout(timeout);
    return drained;
  }

  cleanup() {
    this._stopCommitTimer();
    this._settleCommit();
    this._resetTurn();
    this._recoveryRequested = false;
    super.cleanup();
  }
}

module.exports = { TinfoilRealtimeStreaming, TINFOIL_REALTIME_MODEL };
