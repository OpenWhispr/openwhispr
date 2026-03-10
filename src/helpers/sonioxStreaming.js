const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const WEBSOCKET_TIMEOUT_MS = 15000;
const DISCONNECT_TIMEOUT_MS = 3000;
const KEEPALIVE_INTERVAL_MS = 5000;
const KEEPALIVE_IDLE_LIMIT_MS = 30000; // Stop keepalive if no audio sent for 30s
const COLD_START_BUFFER_MAX = 3 * 16000 * 2; // 3 seconds of 16-bit PCM at 16kHz
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket";

class SonioxStreaming {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.finalTokens = [];
    this.currentNonFinalText = "";
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.keepAliveInterval = null;
    this.isDisconnecting = false;
    this.audioBytesSent = 0;
    this._finalizeSent = false;
    this._lastAudioSentAt = 0;
  }

  getFullTranscript() {
    return this.finalTokens.map((t) => t.text).join("");
  }

  async connect(options = {}) {
    const { apiKey, model, language, secondaryLanguage } = options;
    if (!apiKey) throw new Error("Soniox API key is required");

    if (this.isConnected) {
      debugLogger.debug("Soniox already connected");
      return;
    }

    this.finalTokens = [];
    this.currentNonFinalText = "";
    this.audioBytesSent = 0;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this._finalizeSent = false;

    const toBase = (l) => l && l !== "auto" ? l.split("-")[0] : null;
    const languageHints =
      [toBase(language), toBase(secondaryLanguage)].filter(Boolean);

    debugLogger.debug("Soniox connecting", { model: model || "stt-rt-v4", languageHints });

    const configMessage = {
      api_key: apiKey,
      model: model || "stt-rt-v4",
      audio_format: "pcm_s16le",
      sample_rate: 16000,
      num_channels: 1,
      language_hints: languageHints,
    };

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("Soniox WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(SONIOX_WS_URL);

      this.ws.on("open", () => {
        debugLogger.debug("Soniox WebSocket opened, sending config");
        this.ws.send(JSON.stringify(configMessage));
        this.startKeepAlive();
        this.flushColdStartBuffer();

        clearTimeout(this.connectionTimeout);
        this.isConnected = true;
        this.pendingResolve();
        this.pendingResolve = null;
        this.pendingReject = null;
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (error) => {
        debugLogger.error("Soniox WebSocket error", { error: error.message });
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
        debugLogger.debug("Soniox WebSocket closed", {
          code,
          reason: reason?.toString(),
          wasActive,
        });
        if (this.pendingReject) {
          this.pendingReject(new Error(`WebSocket closed before ready (code: ${code})`));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        this.cleanup();
        if (wasActive && !this.isDisconnecting) {
          this.onSessionEnd?.({ text: this.getFullTranscript() });
        }
      });
    });
  }

  handleMessage(data) {
    try {
      const res = JSON.parse(data.toString());

      if (res.error_code) {
        debugLogger.error("Soniox error response", {
          code: res.error_code,
          message: res.error_message,
        });
        this.onError?.(new Error(`Soniox error ${res.error_code}: ${res.error_message}`));
        return;
      }

      if (res.finished) {
        debugLogger.debug("Soniox session finished", {
          finalTokens: this.finalTokens.length,
          textLength: this.getFullTranscript().length,
        });
        this.onSessionEnd?.({ text: this.getFullTranscript() });
        return;
      }

      let nonFinalTexts = [];
      let newFinalTokens = false;
      for (const token of res.tokens || []) {
        if (token.text === "<fin>") continue;
        if (!token.text || !token.text.trim() || token.text === "\ufffd") continue;
        if (token.is_final) {
          this.finalTokens.push(token);
          newFinalTokens = true;
        } else {
          nonFinalTexts.push(token.text);
        }
      }

      const finalText = this.getFullTranscript();
      this.currentNonFinalText = nonFinalTexts.join("");

      this.onPartialTranscript?.(finalText + this.currentNonFinalText);

      if (newFinalTokens) {
        this.onFinalTranscript?.(finalText);
      }
    } catch (err) {
      debugLogger.error("Soniox message parse error", { error: err.message });
    }
  }

  flushColdStartBuffer() {
    if (this.coldStartBuffer.length === 0) return;

    debugLogger.debug("Soniox flushing cold-start buffer", {
      chunks: this.coldStartBuffer.length,
      bytes: this.coldStartBufferSize,
    });
    for (const buf of this.coldStartBuffer) {
      this.ws.send(buf);
      this.audioBytesSent += buf.length;
    }
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
  }

  sendAudio(pcmBuffer) {
    if (!this.ws) return false;

    if (
      this.ws.readyState === WebSocket.CONNECTING &&
      this.coldStartBufferSize < COLD_START_BUFFER_MAX
    ) {
      const copy = Buffer.from(pcmBuffer);
      this.coldStartBuffer.push(copy);
      this.coldStartBufferSize += copy.length;
      return false;
    }

    if (this.ws.readyState !== WebSocket.OPEN) return false;

    this.flushColdStartBuffer();
    this.ws.send(pcmBuffer);
    this.audioBytesSent += pcmBuffer.length;
    this._lastAudioSentAt = Date.now();
    return true;
  }

  finalize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    this._finalizeSent = true;
    this.ws.send(JSON.stringify({ type: "finalize" }));
    debugLogger.debug("Soniox finalize sent");
    return true;
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this._lastAudioSentAt = Date.now();
    this.keepAliveInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.stopKeepAlive();
        return;
      }
      if (Date.now() - this._lastAudioSentAt > KEEPALIVE_IDLE_LIMIT_MS) {
        debugLogger.debug("Soniox idle timeout, closing connection");
        this.cleanup();
        this.onSessionEnd?.({ text: this.getFullTranscript() });
        return;
      }
      try {
        this.ws.send(JSON.stringify({ type: "keepalive" }));
      } catch (err) {
        debugLogger.debug("Soniox keep-alive failed", { error: err.message });
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

  async disconnect() {
    debugLogger.debug("Soniox disconnect", {
      audioBytesSent: this.audioBytesSent,
      finalTokens: this.finalTokens.length,
      textLength: this.getFullTranscript().length,
    });

    if (!this.ws) return { text: this.getFullTranscript() };

    this.isDisconnecting = true;

    if (this.ws.readyState === WebSocket.OPEN && this.audioBytesSent > 0) {
      if (!this._finalizeSent) {
        await this.drainFinalTokens();
      }
      await this.drainSessionEnd();
    }

    if (this.ws) {
      this.ws.close();
    }

    const result = { text: this.getFullTranscript() };
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  drainFinalTokens() {
    return new Promise((resolve) => {
      const prevOnFinal = this.onFinalTranscript;

      const tid = setTimeout(() => {
        debugLogger.debug("Soniox finalize timeout, using accumulated text");
        this.onFinalTranscript = prevOnFinal;
        resolve();
      }, DISCONNECT_TIMEOUT_MS);

      this.onFinalTranscript = (text) => {
        clearTimeout(tid);
        this.onFinalTranscript = prevOnFinal;
        prevOnFinal?.(text);
        resolve();
      };

      try {
        this.ws.send(JSON.stringify({ type: "finalize" }));
      } catch {
        clearTimeout(tid);
        this.onFinalTranscript = prevOnFinal;
        resolve();
      }
    });
  }

  drainSessionEnd() {
    return new Promise((resolve) => {
      const prevOnSessionEnd = this.onSessionEnd;

      const tid = setTimeout(() => {
        debugLogger.debug("Soniox session end timeout, closing");
        this.onSessionEnd = prevOnSessionEnd;
        resolve();
      }, DISCONNECT_TIMEOUT_MS);

      this.onSessionEnd = (result) => {
        clearTimeout(tid);
        this.onSessionEnd = prevOnSessionEnd;
        prevOnSessionEnd?.(result);
        resolve();
      };

      try {
        this.ws.send("");
      } catch {
        clearTimeout(tid);
        this.onSessionEnd = prevOnSessionEnd;
        resolve();
      }
    });
  }

  cleanup() {
    this.stopKeepAlive();
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;

    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        // ignore
      }
      this.ws = null;
    }

    this.isConnected = false;
  }
}

module.exports = SonioxStreaming;
