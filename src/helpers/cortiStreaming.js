const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const SAMPLE_RATE = 16000;
const WEBSOCKET_TIMEOUT_MS = 30000;
const TERMINATION_TIMEOUT_MS = 5000;
// Corti rejects audio sent before it acknowledges the config message, so buffer
// any frames that arrive during the brief connect handshake.
const PRECONFIG_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 seconds of 16-bit PCM
const AUDIO_FORMAT = `audio/pcm; rate=${SAMPLE_RATE}; channels=1; bits=16`;

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
    this.closeResolve = null;
    this.isDisconnecting = false;
    this.configAccepted = false;
    this.preConfigBuffer = [];
    this.preConfigBufferSize = 0;
    this.sessionStartedAt = null;
    this.audioBytesSent = 0;
    this.currentModel = "corti-transcribe";
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
      audioFormat: AUDIO_FORMAT,
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

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (error) => {
        debugLogger.error("Corti WebSocket error", { error: error.message });
        this.cleanup();
        if (this.pendingReject) {
          this.pendingReject(error);
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        this.onError?.(error);
      });

      this.ws.on("close", (code, reason) => {
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
        if (this.closeResolve) {
          this.closeResolve({ text: this.accumulatedText });
        }
        this.cleanup();
        if (wasActive && !this.isDisconnecting) {
          this.onError?.(new Error(`Connection lost (code: ${code})`));
        }
      });
    });
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

      case "delta_usage":
        if (this.closeResolve) {
          this.closeResolve({ text: this.accumulatedText });
          this.closeResolve = null;
        }
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
      if (this.preConfigBufferSize < PRECONFIG_BUFFER_MAX) {
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

  async disconnect(closeStream = true) {
    if (!this.ws) return { text: this.accumulatedText };

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN) {
      // Flush buffered audio, wait for the trailing finals, then end the session.
      this.ws.send(JSON.stringify({ type: "flush" }));

      let timeoutId;
      const result = await Promise.race([
        new Promise((resolve) => {
          this.closeResolve = resolve;
        }),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => {
            debugLogger.debug("Corti close timeout, using accumulated text");
            resolve({ text: this.accumulatedText });
          }, TERMINATION_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timeoutId);

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "end" }));
      }
      this.closeResolve = null;
      this.onSessionEnd?.({ text: result.text });
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
        this.ws.close();
      } catch (err) {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.configAccepted = false;
    this.sessionId = null;
    this.closeResolve = null;
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      sessionId: this.sessionId,
    };
  }
}

module.exports = CortiStreaming;
