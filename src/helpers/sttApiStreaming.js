// Streaming client for our own stt-api WebSocket (Phase 5, D-05/D-06). Same surface
// as deepgramStreaming.js so meeting prepare/start and the dictation preview can
// drive it unchanged. The license key travels only in the Authorization header.
//
// Two modes, chosen by connect({ segments }):
//   segments (default): offers the `stt-segments` subprotocol and maps server
//     `segment` frames to partial/final callbacks (Note Recording).
//   preview (segments: false): no subprotocol; cumulative `partial` frames replace
//     the preview text (live dictation preview).
const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const {
  sttApiStreamUrl,
  parseSttApiFrame,
  Pcm16Resampler,
  STT_API_SEGMENTS_SUBPROTOCOL,
  STT_API_INPUT_RATE,
} = require("./sttApiStreamPolicy");

const CONNECT_TIMEOUT_MS = 15000;
const FINISH_TIMEOUT_MS = 5000;
// The server closes a stream that sends no audio for 30 s; a warm meeting
// connection waits for the user to press record, so it sends silence between.
const KEEPALIVE_INTERVAL_MS = 3000;
const SILENCE_FRAME = Buffer.alloc((STT_API_INPUT_RATE / 10) * 2);

class SttApiStreaming {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.sessionId = null;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.onConnectionLost = null;
    this.connectionLossNotified = false;
    this.isDisconnecting = false;
    this.segmentsMode = true;
    this.finalSegments = [];
    this.accumulatedText = "";
    this.openSegment = null;
    this.audioBytesSent = 0;
    this.sessionStartedAt = null;
    this.resampler = null;
    this.lastSendAt = 0;
    this.keepAliveInterval = null;
    this.keepAliveMs = KEEPALIVE_INTERVAL_MS;
    this.connectionTimeout = null;
    this.finishPromise = null;
    this.finishResolve = null;
    this.finalText = null;
  }

  get completedSegments() {
    return this.finalSegments;
  }

  async warmup() {
    // Nothing to pre-open: a meeting connects at prepare time, and a refused or
    // unconfigured server must surface there, not at app start.
  }

  async connect(options = {}) {
    const key = options.token || options.apiKey;
    if (!key) throw new Error("A Titanium sign-in is required to open the stream");
    if (this.isConnected) return;

    const url = sttApiStreamUrl(options.baseUrl);
    this.segmentsMode = options.segments !== false;
    this.resampler = new Pcm16Resampler(options.sampleRate || STT_API_INPUT_RATE);
    this.finalSegments = [];
    this.accumulatedText = "";
    this.openSegment = null;
    this.finalText = null;
    this.audioBytesSent = 0;
    this.connectionLossNotified = false;
    this.finishPromise = null;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        if (error) {
          this.cleanup();
          reject(error);
        } else {
          resolve();
        }
      };

      this.connectionTimeout = setTimeout(
        () => settle(new Error("stt-api stream connection timeout")),
        CONNECT_TIMEOUT_MS
      );

      const protocols = this.segmentsMode ? [STT_API_SEGMENTS_SUBPROTOCOL] : [];
      const socket = new WebSocket(url, protocols, {
        headers: { Authorization: `Bearer ${key}` },
      });
      this.ws = socket;

      socket.on("open", () => {
        // Cancelled (cleanup ran) while the handshake was in flight: never arm a keep-alive.
        if (this.ws !== socket) {
          socket.close();
          settle(new Error("stt-api stream connection cancelled"));
          return;
        }
        if (this.segmentsMode && socket.protocol !== STT_API_SEGMENTS_SUBPROTOCOL) {
          settle(new Error("stt-api server did not accept the stt-segments subprotocol"));
          return;
        }
        this.isConnected = true;
        this.sessionStartedAt = Date.now();
        this.lastSendAt = Date.now();
        this._startKeepAlive(socket);
        debugLogger.debug("stt-api stream connected", {
          segments: this.segmentsMode,
          sampleRate: options.sampleRate || STT_API_INPUT_RATE,
        });
        settle(null);
      });

      socket.on("message", (data) => this._handleMessage(data));

      socket.on("error", (error) => {
        const wasActive = this.isConnected;
        debugLogger.error("stt-api stream error", { error: error.message });
        if (!settled) {
          settle(error);
          return;
        }
        this.cleanup();
        if (wasActive && !this.isDisconnecting) this._notifyConnectionLost(error);
      });

      socket.on("close", (code, reason) => {
        const wasActive = this.isConnected;
        debugLogger.debug("stt-api stream closed", {
          code,
          reason: reason?.toString(),
          wasActive,
        });
        if (!settled) {
          settle(new Error(`stt-api stream closed before ready (code: ${code})`));
          return;
        }
        this._resolveFinish();
        this.cleanup();
        if (wasActive && !this.isDisconnecting) {
          this._notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
        }
      });
    });
  }

  _startKeepAlive(socket) {
    this._stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN || this.ws !== socket) {
        this._stopKeepAlive();
        return;
      }
      if (Date.now() - this.lastSendAt < this.keepAliveMs) return;
      try {
        socket.send(SILENCE_FRAME);
        this.lastSendAt = Date.now();
      } catch (error) {
        debugLogger.debug("stt-api keep-alive failed", { error: error.message });
        this._stopKeepAlive();
      }
    }, this.keepAliveMs);
  }

  _stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  _notifyConnectionLost(error) {
    if (this.connectionLossNotified) return;
    this.connectionLossNotified = true;
    if (this.onConnectionLost) this.onConnectionLost(error);
    else this.onError?.(error);
  }

  _commitFinalSegment(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.finalSegments.push(trimmed);
    this.accumulatedText = this.finalSegments.join(" ");
    this.onFinalTranscript?.(this.accumulatedText, Date.now());
  }

  _handleMessage(data) {
    const frame = parseSttApiFrame(data);
    if (!frame) return;

    switch (frame.type) {
      case "partial":
        // In segments mode the same text arrives per segment; only the preview
        // mode consumes the cumulative partial.
        if (!this.segmentsMode) this.onPartialTranscript?.(frame.text);
        break;
      case "segment":
        if (frame.final) {
          this.openSegment = null;
          this._commitFinalSegment(frame.text);
        } else {
          this.openSegment = { index: frame.index, text: frame.text };
          this.onPartialTranscript?.(frame.text);
        }
        break;
      case "final":
        if (frame.truncated) debugLogger.warn("stt-api stream result was truncated");
        this.finalText = frame.text;
        // A segment the server never closed is committed once, never re-emitted
        // from the cumulative final text.
        if (this.openSegment) {
          const pending = this.openSegment.text;
          this.openSegment = null;
          this._commitFinalSegment(pending);
        }
        this._resolveFinish();
        break;
      case "error":
        debugLogger.error("stt-api stream error frame", { code: frame.code });
        this.onError?.(Object.assign(new Error(frame.message), { code: frame.code }));
        break;
      default:
        break;
    }
  }

  _resolveFinish() {
    if (this.finishResolve) {
      this.finishResolve({ text: this.finalText ?? this.accumulatedText });
      this.finishResolve = null;
    }
  }

  sendAudio(pcmBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.resampler) return false;
    const frame = this.resampler.process(pcmBuffer);
    this.audioBytesSent += pcmBuffer.length;
    if (frame.length === 0) return true;
    this.ws.send(frame);
    this.lastSendAt = Date.now();
    return true;
  }

  /** Sends `finish` and resolves with the accumulated text once the closing `final` frame arrives. */
  finalize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ text: this.accumulatedText });
    }
    if (this.finishPromise) return this.finishPromise;
    this._stopKeepAlive();
    this.finishPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        debugLogger.debug("stt-api finish timeout, using accumulated text");
        this._resolveFinish();
      }, FINISH_TIMEOUT_MS);
      this.finishResolve = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
    this.ws.send(JSON.stringify({ type: "finish" }));
    return this.finishPromise;
  }

  async disconnect(closeStream = true) {
    if (!this.ws) return { text: this.finalText ?? this.accumulatedText };
    this.isDisconnecting = true;
    let result = { text: this.finalText ?? this.accumulatedText };
    try {
      if (closeStream && this.ws.readyState === WebSocket.OPEN) {
        result = await this.finalize();
      }
    } finally {
      this.cleanup();
      this.isDisconnecting = false;
    }
    this.accumulatedText = "";
    this.finalSegments = [];
    this.finalText = null;
    return result;
  }

  cleanup() {
    this._stopKeepAlive();
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this._resolveFinish();
    this.finishPromise = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
    this.isConnected = false;
  }

  cleanupAll() {
    this.cleanup();
    this.finalSegments = [];
  }

  getStatus() {
    return { isConnected: this.isConnected, sessionId: this.sessionId };
  }
}

/**
 * Adapter for the dictation preview: the same sendPcm16/abort/finish shape as the
 * local online stream, over the stt-api socket without the segments subprotocol.
 * Cumulative `partial` text goes to onUpdate. Input is already 16 kHz.
 */
async function createSttApiPreviewStream({ baseUrl, key, onUpdate, onError }) {
  const client = new SttApiStreaming();
  client.onPartialTranscript = onUpdate;
  client.onError = onError;
  client.onConnectionLost = onError;
  await client.connect({ baseUrl, token: key, segments: false, sampleRate: STT_API_INPUT_RATE });
  return {
    sendPcm16: (pcm) => client.sendAudio(pcm),
    abort: () => client.cleanup(),
    finish: async () => ({ text: (await client.disconnect()).text || "", truncated: false }),
  };
}

module.exports = SttApiStreaming;
module.exports.createSttApiPreviewStream = createSttApiPreviewStream;
