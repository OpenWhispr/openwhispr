const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const SAMPLE_RATE = 16000;
const WEBSOCKET_TIMEOUT_MS = 30000;
const TERMINATION_TIMEOUT_MS = 5000;
const TOKEN_REFRESH_BUFFER_MS = 30000;
const TOKEN_EXPIRY_MS = 300000;
const REWARM_DELAY_MS = 2000;
const MAX_REWARM_ATTEMPTS = 10;
const KEEPALIVE_INTERVAL_MS = 3000;
const COLD_START_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 seconds of 16-bit PCM
const LIVENESS_TIMEOUT_MS = 2500; // Max wait for first Results from a warm connection

// Languages supported by Nova-3 (base codes). If a language isn't here, fall back to Nova-2.
const NOVA3_LANGUAGES = new Set([
  "ar",
  "be",
  "bn",
  "bs",
  "bg",
  "ca",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "et",
  "fi",
  "fr",
  "de",
  "el",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "kn",
  "ko",
  "lv",
  "lt",
  "mk",
  "ms",
  "mr",
  "no",
  "fa",
  "pl",
  "pt",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sv",
  "tl",
  "ta",
  "te",
  "tr",
  "uk",
  "ur",
  "vi",
  "multi",
]);

// 100ms of silence at 16kHz 16-bit mono — sent to warm connections to prevent
// Deepgram's net0001 idle timeout (which only resets on audio data, not KeepAlive).
const SILENCE_FRAME = Buffer.alloc((SAMPLE_RATE / 10) * 2);

class DeepgramStreaming {
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
    this.finalSegments = [];
    this.closeResolve = null;
    this.cachedToken = null;
    this.tokenFetchedAt = null;
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmConnectionOptions = null;
    this.warmSessionId = null;
    this.rewarmAttempts = 0;
    this.rewarmTimer = null;
    this.keepAliveInterval = null;
    this.isDisconnecting = false;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.tokenRefreshFn = null;
    this.proactiveRefreshTimer = null;
    this._generation = 0;
    this.audioBytesSent = 0;
    this.resultsReceived = 0;
    this.livenessTimer = null;
    this.replayBuffer = [];
    this.replayBufferSize = 0;
    this.connectionOptions = null;
  }

  setTokenRefreshFn(fn) {
    this.tokenRefreshFn = fn;
  }

  buildWebSocketUrl(options) {
    const sampleRate = options.sampleRate || SAMPLE_RATE;
    const lang = options.language && options.language !== "auto" ? options.language : null;
    const baseLang = lang ? lang.split("-")[0].toLowerCase() : null;
    const useNova3 = !lang || NOVA3_LANGUAGES.has(lang) || NOVA3_LANGUAGES.has(baseLang);
    const model = useNova3 ? "nova-3" : "nova-2";

    if (!useNova3) {
      debugLogger.debug("Deepgram falling back to nova-2", { language: lang });
    }

    const params = new URLSearchParams({
      encoding: "linear16",
      sample_rate: String(sampleRate),
      channels: "1",
      model,
      punctuate: "true",
      interim_results: "true",
    });
    if (lang) {
      params.set("language", lang);
    }
    if (Array.isArray(options.keyterms)) {
      // Nova-3 uses "keyterm", Nova-2 uses "keywords"
      const paramName = useNova3 ? "keyterm" : "keywords";
      for (const term of options.keyterms) {
        if (term) params.append(paramName, term);
      }
    }
    return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
  }

  cacheToken(token) {
    this.cachedToken = token;
    this.tokenFetchedAt = Date.now();
    debugLogger.debug("Deepgram token cached", { expiresIn: TOKEN_EXPIRY_MS });
  }

  isTokenValid() {
    if (!this.cachedToken || !this.tokenFetchedAt) return false;
    const age = Date.now() - this.tokenFetchedAt;
    return age < TOKEN_EXPIRY_MS - TOKEN_REFRESH_BUFFER_MS;
  }

  getCachedToken() {
    return this.isTokenValid() ? this.cachedToken : null;
  }

  startKeepAlive(socket) {
    this.stopKeepAlive();
    const target = socket || this.warmConnection;
    const isWarm = !socket;
    debugLogger.debug("Deepgram keep-alive started", { isWarm });
    this.keepAliveInterval = setInterval(() => {
      if (target && target.readyState === WebSocket.OPEN) {
        try {
          // Warm connections send silence audio — Deepgram's net0001 idle timeout
          // only resets on audio data, not KeepAlive messages, for pre-audio sessions.
          // Active connections use KeepAlive JSON (audio flow already resets the timer).
          target.send(isWarm ? SILENCE_FRAME : JSON.stringify({ type: "KeepAlive" }));
        } catch (err) {
          debugLogger.debug("Deepgram keep-alive failed", { error: err.message });
          if (target === this.warmConnection) {
            this.cleanupWarmConnection();
          }
        }
      } else {
        debugLogger.debug("Deepgram keep-alive target gone", {
          isWarm,
          readyState: target?.readyState,
        });
        this.stopKeepAlive();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      debugLogger.debug("Deepgram keep-alive stopped");
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  async warmup(options = {}) {
    const { token } = options;
    if (!token) {
      throw new Error("Streaming token is required for warmup");
    }

    if (this.warmConnection) {
      debugLogger.debug(
        this.warmConnectionReady
          ? "Deepgram connection already warm"
          : "Deepgram warmup already in progress, skipping"
      );
      return;
    }

    this.warmConnectionReady = false;
    this.warmSessionId = null;
    // Only update tokenFetchedAt when the token actually changes —
    // re-warming with the same token must not reset the expiry clock.
    if (token !== this.cachedToken) {
      this.cachedToken = token;
      this.tokenFetchedAt = Date.now();
    }
    this.warmConnectionOptions = options;
    this.rewarmAttempts = 0;

    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("Deepgram warming up connection");

    return new Promise((resolve, reject) => {
      let settled = false;
      const resolveWarmup = (meta = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(warmupTimeout);
        this.warmConnectionReady = true;
        if (meta.requestId) {
          this.warmSessionId = meta.requestId;
        }
        // Send immediate silence frame so the connection doesn't timeout
        // before the first keep-alive interval fires.
        try {
          this.warmConnection?.send(SILENCE_FRAME);
        } catch (err) {
          // Ignore
        }
        this.startKeepAlive();
        this.scheduleProactiveRefresh();
        debugLogger.debug("Deepgram connection warmed up", {
          sessionId: this.warmSessionId,
          via: meta.via || "unknown",
        });
        resolve();
      };

      const warmupTimeout = setTimeout(() => {
        this.cleanupWarmConnection();
        reject(new Error("Deepgram warmup connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.warmConnection = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      this.warmConnection.on("open", () => {
        debugLogger.debug("Deepgram warm connection socket opened");
        // Consider the socket warm as soon as it's open. Deepgram may not emit
        // Metadata until audio starts, which would make startup warmup appear broken.
        resolveWarmup({ via: "open" });
      });

      this.warmConnection.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "Metadata") {
            this.warmSessionId = message.request_id || null;
            resolveWarmup({ requestId: message.request_id, via: "metadata" });
          }
        } catch (err) {
          debugLogger.error("Deepgram warmup message parse error", { error: err.message });
        }
      });

      this.warmConnection.on("error", (error) => {
        clearTimeout(warmupTimeout);
        debugLogger.error("Deepgram warmup connection error", { error: error.message });
        // Invalidate cached token on auth failure so next attempt fetches fresh
        if (error.message && error.message.includes("401")) {
          this.cachedToken = null;
          this.tokenFetchedAt = null;
        }
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      this.warmConnection.on("close", (code, reason) => {
        clearTimeout(warmupTimeout);
        this.stopKeepAlive();
        const wasReady = this.warmConnectionReady;
        const savedOptions = this.warmConnectionOptions ? { ...this.warmConnectionOptions } : null;
        debugLogger.debug("Deepgram warm connection closed", {
          wasReady,
          code,
          reason: reason?.toString(),
        });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          reject(new Error(`Deepgram warmup connection closed (code: ${code})`));
          return;
        }
        if (wasReady && savedOptions) {
          this.warmConnectionOptions = savedOptions;
          this.scheduleRewarm();
        }
      });
    });
  }

  scheduleRewarm() {
    if (this.rewarmAttempts >= MAX_REWARM_ATTEMPTS) {
      debugLogger.debug("Deepgram max re-warm attempts reached, will cold-start next recording");
      return;
    }
    if (this.isConnected) {
      return;
    }
    if (!this.warmConnectionOptions) {
      debugLogger.debug("Deepgram cannot re-warm: no saved options");
      return;
    }

    this.rewarmAttempts++;
    const delay = Math.min(REWARM_DELAY_MS * Math.pow(2, this.rewarmAttempts - 1), 60000);
    debugLogger.debug("Deepgram scheduling re-warm", {
      attempt: this.rewarmAttempts,
      delayMs: delay,
    });
    clearTimeout(this.rewarmTimer);
    this.rewarmTimer = setTimeout(async () => {
      this.rewarmTimer = null;
      if (this.hasWarmConnection() || this.isConnected) return;

      let token = this.getCachedToken();
      if (!token && this.tokenRefreshFn) {
        try {
          token = await this.tokenRefreshFn();
          if (token) this.cacheToken(token);
        } catch (err) {
          debugLogger.debug("Deepgram token refresh for re-warm failed", {
            error: err.message,
          });
        }
      }
      if (!token) {
        debugLogger.debug("Deepgram cannot re-warm: no valid token");
        return;
      }

      this.warmup({ ...this.warmConnectionOptions, token }).catch((err) => {
        debugLogger.debug("Deepgram auto re-warm failed", { error: err.message });
      });
    }, delay);
  }

  scheduleProactiveRefresh() {
    clearTimeout(this.proactiveRefreshTimer);
    const refreshDelay = TOKEN_EXPIRY_MS - TOKEN_REFRESH_BUFFER_MS * 2;
    this.proactiveRefreshTimer = setTimeout(async () => {
      this.proactiveRefreshTimer = null;
      if (!this.hasWarmConnection() || this.isConnected) return;

      const savedOptions = this.warmConnectionOptions ? { ...this.warmConnectionOptions } : null;
      if (!savedOptions || !this.tokenRefreshFn) return;

      let newToken;
      try {
        newToken = await this.tokenRefreshFn();
      } catch (err) {
        debugLogger.debug("Deepgram proactive token refresh failed", {
          error: err.message,
        });
        return;
      }
      if (!newToken || this.isConnected) return;

      debugLogger.debug("Deepgram rotating warm connection with fresh token");
      this.cleanupWarmConnection();
      this.cacheToken(newToken);
      this.rewarmAttempts = 0;
      this.warmup({ ...savedOptions, token: newToken }).catch((err) => {
        debugLogger.debug("Deepgram proactive re-warm failed", { error: err.message });
      });
    }, refreshDelay);
  }

  useWarmConnection() {
    if (!this.warmConnection || !this.warmConnectionReady) {
      return false;
    }

    if (this.warmConnection.readyState !== WebSocket.OPEN) {
      debugLogger.debug("Deepgram warm connection readyState not OPEN, discarding", {
        readyState: this.warmConnection.readyState,
      });
      this.cleanupWarmConnection();
      return false;
    }

    this.stopKeepAlive();
    clearTimeout(this.proactiveRefreshTimer);
    this.proactiveRefreshTimer = null;

    this.ws = this.warmConnection;
    this.isConnected = true;
    this.sessionId = this.warmSessionId || null;
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmSessionId = null;

    this.ws.removeAllListeners("message");
    this.ws.on("message", (data) => {
      this.handleMessage(data);
    });

    this.ws.removeAllListeners("error");
    this.ws.on("error", (error) => {
      debugLogger.error("Deepgram WebSocket error", { error: error.message });
      this.cleanup();
      this.onError?.(error);
    });

    this.ws.removeAllListeners("close");
    this.ws.on("close", (code, reason) => {
      const wasActive = this.isConnected;
      debugLogger.debug("Deepgram WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      if (this.closeResolve) {
        this.closeResolve({ text: this.accumulatedText });
      }
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.onError?.(new Error(`Connection lost (code: ${code})`));
      }
    });

    this.startKeepAlive(this.ws);
    debugLogger.debug("Deepgram using pre-warmed connection");
    return true;
  }

  cleanupWarmConnection() {
    this.stopKeepAlive();
    clearTimeout(this.proactiveRefreshTimer);
    this.proactiveRefreshTimer = null;
    if (this.warmConnection) {
      try {
        this.warmConnection.close();
      } catch (err) {
        // Ignore
      }
      this.warmConnection = null;
    }
    this.warmConnectionReady = false;
    this.warmConnectionOptions = null;
    this.warmSessionId = null;
  }

  hasWarmConnection() {
    const result =
      this.warmConnection !== null &&
      this.warmConnectionReady &&
      this.warmConnection.readyState === WebSocket.OPEN;
    if (!result && (this.warmConnection || this.warmConnectionReady)) {
      debugLogger.debug("Deepgram hasWarmConnection=false", {
        hasSocket: this.warmConnection !== null,
        ready: this.warmConnectionReady,
        readyState: this.warmConnection?.readyState,
        hasKeepAlive: this.keepAliveInterval !== null,
      });
    }
    return result;
  }

  startLivenessCheck() {
    clearTimeout(this.livenessTimer);
    this.livenessTimer = setTimeout(() => {
      this.handleLivenessTimeout().catch((err) => {
        debugLogger.error("Deepgram liveness reconnect error", { error: err.message });
      });
    }, LIVENESS_TIMEOUT_MS);
  }

  async handleLivenessTimeout() {
    if (this.resultsReceived > 0 || !this.isConnected) return;

    const gen = this._generation;
    const savedReplay = this.replayBuffer;

    debugLogger.warn("Deepgram warm connection unresponsive, reconnecting", {
      audioBytesSent: this.audioBytesSent,
    });

    this.isDisconnecting = true;
    this.cleanup();
    this.isDisconnecting = false;

    if (gen !== this._generation) return;

    let token = this.getCachedToken();
    if (!token && this.tokenRefreshFn) {
      try {
        token = await this.tokenRefreshFn();
        if (token) this.cacheToken(token);
      } catch (err) {
        debugLogger.error("Deepgram reconnect token refresh failed", { error: err.message });
        return;
      }
    }
    if (!token) return;
    if (gen !== this._generation) return;

    try {
      await this.connect({
        ...this.connectionOptions,
        token,
        replayBuffer: savedReplay,
        forceNew: true,
      });
      debugLogger.debug("Deepgram liveness reconnect succeeded");
    } catch (err) {
      debugLogger.error("Deepgram liveness reconnect failed", { error: err.message });
    }
  }

  async connect(options = {}) {
    const { token, replayBuffer, forceNew } = options;
    if (!token) {
      throw new Error("Streaming token is required");
    }

    if (this.isConnected) {
      debugLogger.debug("Deepgram streaming already connected");
      return;
    }

    this.connectionOptions = {
      sampleRate: options.sampleRate,
      language: options.language,
      keyterms: options.keyterms,
    };
    this.accumulatedText = "";
    this.finalSegments = [];
    this.audioBytesSent = 0;
    this.resultsReceived = 0;

    if (replayBuffer && replayBuffer.length > 0) {
      this.coldStartBuffer = replayBuffer;
      this.coldStartBufferSize = replayBuffer.reduce((sum, b) => sum + b.length, 0);
      debugLogger.debug("Deepgram replaying buffered audio", {
        chunks: replayBuffer.length,
        bytes: this.coldStartBufferSize,
      });
    } else {
      this.coldStartBuffer = [];
      this.coldStartBufferSize = 0;
    }

    if (!forceNew && this.hasWarmConnection()) {
      if (this.useWarmConnection()) {
        this.startLivenessCheck();
        debugLogger.debug("Deepgram using warm connection - instant start");
        return;
      }
    }

    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("Deepgram streaming connecting (cold start)");

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("Deepgram WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      this.ws.on("open", () => {
        debugLogger.debug("Deepgram WebSocket connected");
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (error) => {
        debugLogger.error("Deepgram WebSocket error", { error: error.message });
        // Invalidate cached token on auth failure so next attempt fetches fresh
        if (error.message && error.message.includes("401")) {
          this.cachedToken = null;
          this.tokenFetchedAt = null;
        }
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
        debugLogger.debug("Deepgram WebSocket closed", {
          code,
          reason: reason?.toString(),
          wasActive,
        });
        if (this.pendingReject) {
          this.pendingReject(new Error(`WebSocket closed before ready (code: ${code})`));
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
    try {
      const message = JSON.parse(data.toString());

      // Resolve pending connect() promise on first valid message.
      // With nova-3, when audio is already flowing, Deepgram may skip
      // the Metadata message and jump straight to SpeechStarted/Results.
      if (this.pendingResolve) {
        this.isConnected = true;
        clearTimeout(this.connectionTimeout);
        this.startKeepAlive(this.ws);
        if (message.type === "Metadata") {
          this.sessionId = message.request_id;
        }
        debugLogger.debug("Deepgram session started", {
          sessionId: this.sessionId,
          firstMessageType: message.type,
        });
        this.pendingResolve();
        this.pendingResolve = null;
        this.pendingReject = null;
      }

      switch (message.type) {
        case "Metadata":
          this.sessionId = message.request_id;
          break;

        case "Results": {
          this.resultsReceived++;
          if (this.livenessTimer) {
            clearTimeout(this.livenessTimer);
            this.livenessTimer = null;
            this.replayBuffer = [];
            this.replayBufferSize = 0;
          }
          const transcript = message.channel?.alternatives?.[0]?.transcript;
          if (!transcript) break;

          if (message.is_final || message.from_finalize) {
            const trimmed = transcript.trim();
            if (trimmed) {
              this.finalSegments.push(trimmed);
              this.accumulatedText = this.finalSegments.join(" ");
              this.onFinalTranscript?.(this.accumulatedText);
              debugLogger.debug("Deepgram final transcript", {
                text: trimmed.slice(0, 100),
                totalAccumulated: this.accumulatedText.length,
              });
            }
          } else {
            this.onPartialTranscript?.(transcript);
          }
          break;
        }

        case "UtteranceEnd":
          debugLogger.debug("Deepgram utterance end");
          break;

        case "SpeechStarted":
          debugLogger.debug("Deepgram speech started");
          break;

        case "Error":
          debugLogger.error("Deepgram streaming error", { error: message.description });
          this.onError?.(new Error(message.description || "Deepgram error"));
          break;

        default:
          debugLogger.debug("Deepgram unknown message type", { type: message.type });
      }
    } catch (err) {
      debugLogger.error("Deepgram message parse error", { error: err.message });
    }
  }

  sendAudio(pcmBuffer) {
    if (!this.ws) return false;

    if (this.ws.readyState !== WebSocket.OPEN) {
      // Buffer audio during cold start so no frames are lost while WebSocket connects
      if (
        this.ws.readyState === WebSocket.CONNECTING &&
        this.coldStartBufferSize < COLD_START_BUFFER_MAX
      ) {
        const copy = Buffer.from(pcmBuffer);
        this.coldStartBuffer.push(copy);
        this.coldStartBufferSize += copy.length;
      }
      return false;
    }

    if (this.keepAliveInterval) {
      this.stopKeepAlive();
    }

    // Flush any audio buffered during cold start
    if (this.coldStartBuffer.length > 0) {
      debugLogger.debug("Deepgram flushing cold-start buffer", {
        chunks: this.coldStartBuffer.length,
        bytes: this.coldStartBufferSize,
      });
      for (const buf of this.coldStartBuffer) {
        this.ws.send(buf);
      }
      this.coldStartBuffer = [];
      this.coldStartBufferSize = 0;
    }

    if (this.livenessTimer) {
      const copy = Buffer.from(pcmBuffer);
      this.replayBuffer.push(copy);
      this.replayBufferSize += copy.length;
    }

    this.audioBytesSent += pcmBuffer.length;
    this.ws.send(pcmBuffer);
    return true;
  }

  finalize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.ws.send(JSON.stringify({ type: "Finalize" }));
    debugLogger.debug("Deepgram Finalize sent");
    return true;
  }

  async disconnect(closeStream = true) {
    this._generation++;
    clearTimeout(this.livenessTimer);
    this.livenessTimer = null;

    debugLogger.debug("Deepgram disconnect", {
      audioBytesSent: this.audioBytesSent,
      resultsReceived: this.resultsReceived,
      textLength: this.accumulatedText.length,
    });

    if (!this.ws) return { text: this.accumulatedText };

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));

      let timeoutId;
      const result = await Promise.race([
        new Promise((resolve) => {
          this.closeResolve = resolve;
        }),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => {
            debugLogger.debug("Deepgram close timeout, using accumulated text");
            resolve({ text: this.accumulatedText });
          }, TERMINATION_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timeoutId);

      this.closeResolve = null;
      this.cleanup();
      this.isDisconnecting = false;
      this.accumulatedText = "";
      this.finalSegments = [];
      return result;
    }

    const result = { text: this.accumulatedText };
    this.cleanup();
    this.isDisconnecting = false;
    this.accumulatedText = "";
    this.finalSegments = [];
    return result;
  }

  cleanup() {
    this.stopKeepAlive();
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    clearTimeout(this.livenessTimer);
    this.livenessTimer = null;
    this.replayBuffer = [];
    this.replayBufferSize = 0;

    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.sessionId = null;
    this.closeResolve = null;
  }

  cleanupAll() {
    this.cleanup();
    this.cleanupWarmConnection();
    clearTimeout(this.rewarmTimer);
    this.rewarmTimer = null;
    clearTimeout(this.proactiveRefreshTimer);
    this.proactiveRefreshTimer = null;
    this.cachedToken = null;
    this.tokenFetchedAt = null;
    this.warmConnectionOptions = null;
    this.finalSegments = [];
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      sessionId: this.sessionId,
      hasWarmConnection: this.hasWarmConnection(),
      hasValidToken: this.isTokenValid(),
    };
  }
}

module.exports = DeepgramStreaming;
