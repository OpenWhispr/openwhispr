const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const SAMPLE_RATE = 16000;
const WEBSOCKET_TIMEOUT_MS = 30000;
const TERMINATION_TIMEOUT_MS = 5000;
const KEEPALIVE_INTERVAL_MS = 15000;

// Corti's WSS transport: OAuth token in the query, a JSON config message after
// open, then raw PCM frames. Mirrors the AssemblyAI/Deepgram streaming classes.
class CortiStreaming {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.accumulatedText = "";
    this.completedSegments = [];
    this.pendingAck = null;
    this.isDisconnecting = false;
    this.configAccepted = false;
    this.preConfigBuffer = [];
    this.preConfigBufferSize = 0;
    this.sessionStartedAt = null;
    this.audioBytesSent = 0;
    this.currentModel = "corti-transcribe";
    this.sampleRate = SAMPLE_RATE;
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.warmSessionStartedAt = null;
    this.keepAliveInterval = null;
  }

  buildWebSocketUrl(options) {
    const params = new URLSearchParams({
      "tenant-name": options.tenant,
      token: `Bearer ${options.token}`,
    });
    return `wss://api.${options.environment}.corti.app/audio-bridge/v2/transcribe?${params}`;
  }

  buildConfiguration(options) {
    const configuration = {
      primaryLanguage: options.language && options.language !== "auto" ? options.language : "en",
      interimResults: true,
      automaticPunctuation: true,
      audioFormat: `audio/pcm; rate=${this.sampleRate}; channels=1; bits=16`,
    };
    if (options.keyterms && options.keyterms.length > 0) {
      configuration.keyterms = { terms: options.keyterms.map((term) => ({ term })) };
    }
    return configuration;
  }

  async connect(options = {}) {
    const { token, environment, tenant } = options;
    if (!token || !environment || !tenant) {
      throw new Error("Corti streaming requires token, environment, and tenant");
    }

    if (this.isConnected) {
      debugLogger.debug("Corti streaming already connected");
      return;
    }

    this.accumulatedText = "";
    this.completedSegments = [];
    this.configAccepted = false;
    this.preConfigBuffer = [];
    this.preConfigBufferSize = 0;
    this.audioBytesSent = 0;
    this.sampleRate = options.sampleRate || SAMPLE_RATE;

    // Reuse the pre-warmed socket for an instant start; cold-connect otherwise.
    if (this.useWarmConnection()) {
      debugLogger.debug("Corti using warm connection - instant start");
      return;
    }

    const url = this.buildWebSocketUrl(options);
    const configuration = this.buildConfiguration(options);
    debugLogger.debug("Corti streaming connecting", { environment, tenant });

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("Corti WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(url);
      this.ws.on("open", () => {
        debugLogger.debug("Corti WebSocket connected, sending config");
        this.ws.send(JSON.stringify({ type: "config", configuration }));
      });
      this.attachSocketHandlers(this.ws);
    });
  }

  // Live-socket wiring shared by the cold connect and a promoted warm connection.
  attachSocketHandlers(ws) {
    ws.on("message", (data) => {
      this.handleMessage(data);
    });

    ws.on("error", (error) => {
      debugLogger.error("Corti WebSocket error", { error: error.message });
      this.cleanup();
      if (this.pendingReject) {
        this.pendingReject(error);
        this.pendingReject = null;
        this.pendingResolve = null;
      }
      this.onError?.(error);
    });

    ws.on("close", (code, reason) => {
      const wasActive = this.isConnected;
      debugLogger.debug("Corti WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      if (this.pendingReject) {
        this.pendingReject(new Error(`Corti WebSocket closed before ready (code: ${code})`));
        this.pendingReject = null;
        this.pendingResolve = null;
      }
      this.resolvePendingAck();
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.onError?.(new Error(`Connection lost (code: ${code})`));
      }
    });
  }

  // Pre-open the socket and finish the config handshake before recording, so the
  // first words aren't lost waiting for CONFIG_ACCEPTED. Mirrors Deepgram/AssemblyAI.
  async warmup(options = {}) {
    const { token, environment, tenant } = options;
    if (!token || !environment || !tenant) {
      throw new Error("Corti warmup requires token, environment, and tenant");
    }
    if (this.warmConnection) {
      debugLogger.debug(
        this.warmConnectionReady
          ? "Corti connection already warm"
          : "Corti warmup already in progress, skipping"
      );
      return;
    }

    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.sampleRate = options.sampleRate || SAMPLE_RATE;

    const url = this.buildWebSocketUrl(options);
    const configuration = this.buildConfiguration(options);
    debugLogger.debug("Corti warming up connection", { environment, tenant });

    return new Promise((resolve, reject) => {
      let settled = false;
      const warmupTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.cleanupWarmConnection();
        reject(new Error("Corti warmup connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.warmConnection = new WebSocket(url);

      this.warmConnection.on("open", () => {
        debugLogger.debug("Corti warm connection opened, sending config");
        this.warmConnection.send(JSON.stringify({ type: "config", configuration }));
      });

      this.warmConnection.on("message", (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch (err) {
          return;
        }
        if (message.type === "CONFIG_ACCEPTED" && !settled) {
          settled = true;
          clearTimeout(warmupTimeout);
          this.warmConnectionReady = true;
          this.warmSessionId = message.sessionId || null;
          this.warmSessionStartedAt = Date.now();
          this.startKeepAlive();
          debugLogger.debug("Corti connection warmed up", { sessionId: this.warmSessionId });
          resolve();
        }
      });

      this.warmConnection.on("error", (error) => {
        debugLogger.error("Corti warmup connection error", { error: error.message });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          clearTimeout(warmupTimeout);
          reject(error);
        }
      });

      this.warmConnection.on("close", (code, reason) => {
        clearTimeout(warmupTimeout);
        const wasReady = this.warmConnectionReady;
        debugLogger.debug("Corti warm connection closed", {
          code,
          reason: reason?.toString(),
          wasReady,
        });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          reject(new Error(`Corti warmup connection closed (code: ${code})`));
        }
      });
    });
  }

  hasWarmConnection() {
    return (
      this.warmConnection !== null &&
      this.warmConnectionReady &&
      this.warmConnection.readyState === WebSocket.OPEN
    );
  }

  // Promote the warm socket to the active session — config is already accepted, so
  // audio flows immediately. Returns false (clearing any stale socket) if none usable.
  useWarmConnection() {
    if (!this.hasWarmConnection()) {
      this.cleanupWarmConnection();
      return false;
    }

    this.stopKeepAlive();
    this.ws = this.warmConnection;
    this.isConnected = true;
    this.configAccepted = true;
    this.sessionId = this.warmSessionId || null;
    this.sessionStartedAt = this.warmSessionStartedAt || Date.now();
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.warmSessionStartedAt = null;

    this.ws.removeAllListeners("open");
    this.ws.removeAllListeners("message");
    this.ws.removeAllListeners("error");
    this.ws.removeAllListeners("close");
    this.attachSocketHandlers(this.ws);
    return true;
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.warmConnection?.readyState === WebSocket.OPEN) {
        try {
          this.warmConnection.ping();
        } catch (err) {
          debugLogger.debug("Corti keep-alive ping failed", { error: err.message });
          this.cleanupWarmConnection();
        }
      } else {
        this.stopKeepAlive();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  cleanupWarmConnection() {
    this.stopKeepAlive();
    if (this.warmConnection) {
      try {
        this.warmConnection.close(1000);
      } catch (err) {
        // Ignore close errors
      }
      this.warmConnection = null;
    }
    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.warmSessionStartedAt = null;
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      debugLogger.error("Corti message parse error", { error: err.message });
      return;
    }

    switch (message.type) {
      case "CONFIG_ACCEPTED":
        this.isConnected = true;
        this.configAccepted = true;
        this.sessionId = message.sessionId || null;
        this.sessionStartedAt = Date.now();
        clearTimeout(this.connectionTimeout);
        this.flushPreConfigBuffer();
        debugLogger.debug("Corti session started", { sessionId: this.sessionId });
        if (this.pendingResolve) {
          this.pendingResolve();
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        break;

      case "transcript": {
        const text = message.data?.text;
        if (!text) break;
        if (message.data.isFinal) {
          const trimmed = text.trim();
          if (!trimmed) break;
          this.completedSegments.push(trimmed);
          this.accumulatedText = this.completedSegments.join(" ");
          const startedAt =
            this.sessionStartedAt != null && typeof message.data.start === "number"
              ? this.sessionStartedAt + message.data.start * 1000
              : Date.now();
          this.onFinalTranscript?.(this.accumulatedText, startedAt);
        } else {
          this.onPartialTranscript?.(text);
        }
        break;
      }

      case "flushed":
      case "ended":
        if (this.pendingAck?.type === message.type) {
          this.resolvePendingAck();
        }
        break;

      case "delta_usage":
      case "usage":
        break;

      case "error":
        debugLogger.error("Corti streaming error", { error: message.error });
        this.onError?.(new Error(message.error?.title || message.error?.details || "Corti error"));
        break;

      default:
        debugLogger.debug("Corti unknown message type", { type: message.type });
    }
  }

  flushPreConfigBuffer() {
    if (this.preConfigBuffer.length === 0) return;
    debugLogger.debug("Corti flushing pre-config buffer", {
      chunks: this.preConfigBuffer.length,
      bytes: this.preConfigBufferSize,
    });
    for (const frame of this.preConfigBuffer) {
      this.ws.send(frame);
      this.audioBytesSent += frame.length;
    }
    this.preConfigBuffer = [];
    this.preConfigBufferSize = 0;
  }

  sendAudio(pcmBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (!this.configAccepted) {
      // Corti rejects audio sent before it acks config; cap the handshake buffer at ~3s.
      if (this.preConfigBufferSize < 3 * this.sampleRate * 2) {
        const copy = Buffer.from(pcmBuffer);
        this.preConfigBuffer.push(copy);
        this.preConfigBufferSize += copy.length;
      }
      return true;
    }

    this.audioBytesSent += pcmBuffer.length;
    this.ws.send(pcmBuffer);
    return true;
  }

  finalize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify({ type: "flush" }));
    debugLogger.debug("Corti flush sent");
    return true;
  }

  // Resolves a single in-flight waitForAck (server ack or socket close).
  resolvePendingAck() {
    if (!this.pendingAck) return;
    clearTimeout(this.pendingAck.timer);
    this.pendingAck.resolve();
    this.pendingAck = null;
  }

  waitForAck(type) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        resolve();
      }, TERMINATION_TIMEOUT_MS);
      this.pendingAck = { type, resolve, timer };
    });
  }

  async disconnect(closeStream = true) {
    if (!this.ws) return { text: this.accumulatedText };

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN) {
      // Corti's close handshake: flush buffered audio, wait for the trailing
      // finals (`flushed`), then signal `end` and close cleanly.
      this.ws.send(JSON.stringify({ type: "flush" }));
      await this.waitForAck("flushed");

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "end" }));
      }

      const result = { text: this.accumulatedText };
      this.onSessionEnd?.(result);
      this.cleanup();
      this.isDisconnecting = false;
      return result;
    }

    const result = { text: this.accumulatedText };
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  cleanup() {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.preConfigBuffer = [];
    this.preConfigBufferSize = 0;

    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch (err) {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.configAccepted = false;
    this.sessionId = null;
    this.resolvePendingAck();
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      sessionId: this.sessionId,
    };
  }
}

module.exports = CortiStreaming;
