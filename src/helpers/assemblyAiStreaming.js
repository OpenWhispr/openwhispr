const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const SAMPLE_RATE = 16000;
const WEBSOCKET_TIMEOUT_MS = 30000;
const TERMINATION_TIMEOUT_MS = 5000;
const TOKEN_REFRESH_BUFFER_MS = 30000;
const TOKEN_EXPIRY_MS = 300000;
const REWARM_DELAY_MS = 2000;
const MAX_REWARM_ATTEMPTS = 10;
const KEEPALIVE_INTERVAL_MS = 15000;

class AssemblyAiStreaming {
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
    this.lastTurnText = "";
    this.turns = [];
    this.terminationResolve = null;
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
  }

  buildWebSocketUrl(options) {
    const sampleRate = options.sampleRate || SAMPLE_RATE;
    const params = new URLSearchParams({
      sample_rate: String(sampleRate),
      encoding: "pcm_s16le",
      format_turns: "true",
      token: options.token,
    });
    if (options.model) {
      params.set("speech_model", options.model);
    }
    if (options.minTurnSilence != null) {
      params.set("min_turn_silence", String(options.minTurnSilence));
    }
    if (options.maxTurnSilence != null) {
      params.set("max_turn_silence", String(options.maxTurnSilence));
    }
    if (options.keyterms && options.keyterms.length > 0) {
      params.set("keyterms_prompt", JSON.stringify(options.keyterms.slice(0, 100)));
    }
    return `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
  }

  cacheToken(token) {
    this.cachedToken = token;
    this.tokenFetchedAt = Date.now();
    debugLogger.debug("AssemblyAI token cached", { expiresIn: TOKEN_EXPIRY_MS });
  }

  isTokenValid() {
    if (!this.cachedToken || !this.tokenFetchedAt) return false;
    const age = Date.now() - this.tokenFetchedAt;
    return age < TOKEN_EXPIRY_MS - TOKEN_REFRESH_BUFFER_MS;
  }

  getCachedToken() {
    return this.isTokenValid() ? this.cachedToken : null;
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveInterval = setInterval(() => {
      if (this.warmConnection && this.warmConnection.readyState === WebSocket.OPEN) {
        try {
          this.warmConnection.ping();
        } catch (err) {
          debugLogger.debug("AssemblyAI keep-alive ping failed", { error: err.message });
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

  async warmup(options = {}) {
    const { token } = options;
    if (!token) {
      throw new Error("Streaming token is required for warmup");
    }

    if (this.warmConnection) {
      debugLogger.debug(
        this.warmConnectionReady
          ? "AssemblyAI connection already warm"
          : "AssemblyAI warmup already in progress, skipping"
      );
      return;
    }

    this.warmConnectionReady = false;
    this.warmSessionId = null;
    this.cachedToken = token;
    this.tokenFetchedAt = Date.now();
    this.warmConnectionOptions = options;
    this.rewarmAttempts = 0;

    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("AssemblyAI warming up connection");

    return new Promise((resolve, reject) => {
      const warmupTimeout = setTimeout(() => {
        this.cleanupWarmConnection();
        reject(new Error("AssemblyAI warmup connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.warmConnection = new WebSocket(url);

      this.warmConnection.on("open", () => {
        debugLogger.debug("AssemblyAI warm connection socket opened");
      });

      this.warmConnection.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "Begin") {
            clearTimeout(warmupTimeout);
            this.warmConnectionReady = true;
            this.warmSessionId = message.id || null;
            this.startKeepAlive();
            debugLogger.debug("AssemblyAI connection warmed up", { sessionId: message.id });
            resolve();
          }
        } catch (err) {
          debugLogger.error("AssemblyAI warmup message parse error", { error: err.message });
        }
      });

      this.warmConnection.on("error", (error) => {
        clearTimeout(warmupTimeout);
        debugLogger.error("AssemblyAI warmup connection error", { error: error.message });
        this.cleanupWarmConnection();
        reject(error);
      });

      this.warmConnection.on("close", (code, reason) => {
        clearTimeout(warmupTimeout);
        this.stopKeepAlive();
        const wasReady = this.warmConnectionReady;
        const savedOptions = this.warmConnectionOptions ? { ...this.warmConnectionOptions } : null;
        debugLogger.debug("AssemblyAI warm connection closed", {
          wasReady,
          code,
          reason: reason?.toString(),
        });
        this.cleanupWarmConnection();
        if (wasReady && savedOptions) {
          this.warmConnectionOptions = savedOptions;
          this.scheduleRewarm();
        }
      });
    });
  }

  scheduleRewarm() {
    if (this.rewarmAttempts >= MAX_REWARM_ATTEMPTS) {
      debugLogger.debug("AssemblyAI max re-warm attempts reached, will cold-start next recording");
      return;
    }
    if (this.isConnected) {
      // Active session in progress, don't re-warm
      return;
    }
    const token = this.getCachedToken();
    if (!token || !this.warmConnectionOptions) {
      debugLogger.debug("AssemblyAI cannot re-warm: no valid token or options");
      return;
    }

    this.rewarmAttempts++;
    const delay = Math.min(REWARM_DELAY_MS * Math.pow(2, this.rewarmAttempts - 1), 60000);
    debugLogger.debug("AssemblyAI scheduling re-warm", {
      attempt: this.rewarmAttempts,
      delayMs: delay,
    });
    clearTimeout(this.rewarmTimer);
    this.rewarmTimer = setTimeout(() => {
      this.rewarmTimer = null;
      if (this.hasWarmConnection() || this.isConnected) return;
      this.warmup({ ...this.warmConnectionOptions, token }).catch((err) => {
        debugLogger.debug("AssemblyAI auto re-warm failed", { error: err.message });
      });
    }, delay);
  }

  useWarmConnection() {
    if (!this.warmConnection || !this.warmConnectionReady) {
      return false;
    }

    if (this.warmConnection.readyState !== WebSocket.OPEN) {
      debugLogger.debug("AssemblyAI warm connection readyState not OPEN, discarding", {
        readyState: this.warmConnection.readyState,
      });
      this.cleanupWarmConnection();
      return false;
    }

    this.stopKeepAlive();

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
      debugLogger.error("AssemblyAI WebSocket error", { error: error.message });
      this.cleanup();
      this.onError?.(error);
    });

    this.ws.removeAllListeners("close");
    this.ws.on("close", (code, reason) => {
      const wasActive = this.isConnected;
      debugLogger.debug("AssemblyAI WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.onError?.(new Error(`Connection lost (code: ${code})`));
      }
    });

    debugLogger.debug("AssemblyAI using pre-warmed connection");
    return true;
  }

  cleanupWarmConnection() {
    this.stopKeepAlive();
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
    return (
      this.warmConnection !== null &&
      this.warmConnectionReady &&
      this.warmConnection.readyState === WebSocket.OPEN
    );
  }

  async connect(options = {}) {
    const { token } = options;
    if (!token) {
      throw new Error("Streaming token is required");
    }

    if (this.isConnected) {
      debugLogger.debug("AssemblyAI streaming already connected");
      return;
    }

    // Reset accumulated text for new session
    this.accumulatedText = "";
    this.lastTurnText = "";
    this.turns = [];

    // Try to use pre-warmed connection for instant start
    if (this.hasWarmConnection()) {
      if (this.useWarmConnection()) {
        debugLogger.debug("AssemblyAI using warm connection - instant start");
        return;
      }
    }

    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("AssemblyAI streaming connecting (cold start)");

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("AssemblyAI WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        debugLogger.debug("AssemblyAI WebSocket connected");
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (error) => {
        debugLogger.error("AssemblyAI WebSocket error", { error: error.message });
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
        debugLogger.debug("AssemblyAI WebSocket closed", {
          code,
          reason: reason?.toString(),
          wasActive,
        });
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

      switch (message.type) {
        case "Begin":
          this.sessionId = message.id;
          this.isConnected = true;
          clearTimeout(this.connectionTimeout);
          debugLogger.debug("AssemblyAI session started", { sessionId: this.sessionId });
          if (this.pendingResolve) {
            this.pendingResolve();
            this.pendingResolve = null;
            this.pendingReject = null;
          }
          break;

        case "Turn":
          if (message.transcript) {
            if (message.end_of_turn) {
              // Turn has ended - append once, then replace with formatted variant if needed
              const trimmedTranscript = message.transcript.trim();
              const normalizedTranscript = this.normalizeTurnText(trimmedTranscript);
              const previousTurn = this.turns[this.turns.length - 1];

              if (!trimmedTranscript || !normalizedTranscript) {
                break;
              }

              if (previousTurn && previousTurn.normalized === normalizedTranscript) {
                // AssemblyAI can emit the same turn twice (raw then formatted). Replace previous
                // turn only when this variant is formatted, otherwise ignore duplicate.
                if (message.turn_is_formatted && previousTurn.text !== trimmedTranscript) {
                  previousTurn.text = trimmedTranscript;
                  this.lastTurnText = trimmedTranscript;
                  this.accumulatedText = this.turns.map((turn) => turn.text).join(" ");
                  this.onFinalTranscript?.(this.accumulatedText);
                  debugLogger.debug("AssemblyAI formatted turn update applied", {
                    text: trimmedTranscript.slice(0, 100),
                    totalAccumulated: this.accumulatedText.length,
                  });
                } else {
                  debugLogger.debug("AssemblyAI duplicate turn ignored", {
                    text: trimmedTranscript.slice(0, 100),
                  });
                }
                break;
              }

              this.turns.push({
                text: trimmedTranscript,
                normalized: normalizedTranscript,
              });
              this.lastTurnText = trimmedTranscript;
              this.accumulatedText = this.turns.map((turn) => turn.text).join(" ");
              this.onFinalTranscript?.(this.accumulatedText);
              debugLogger.debug("AssemblyAI final transcript (end_of_turn)", {
                text: message.transcript.slice(0, 100),
                totalAccumulated: this.accumulatedText.length,
              });
            } else if (message.turn_is_formatted) {
              // Formatted but turn not ended yet - show as preview without accumulating
              this.onPartialTranscript?.(message.transcript);
            } else {
              // Partial transcript - show real-time updates (current turn only)
              this.onPartialTranscript?.(message.transcript);
            }
          }
          break;

        case "Termination":
          debugLogger.debug("AssemblyAI session terminated", {
            audioDuration: message.audio_duration_seconds,
          });
          // Resolve any pending termination wait
          if (this.terminationResolve) {
            this.terminationResolve({
              audioDuration: message.audio_duration_seconds,
              text: this.accumulatedText,
            });
            this.terminationResolve = null;
          }
          this.onSessionEnd?.({
            audioDuration: message.audio_duration_seconds,
            text: this.accumulatedText,
          });
          this.cleanup();
          break;

        case "Error":
          debugLogger.error("AssemblyAI streaming error", { error: message.error });
          this.onError?.(new Error(message.error));
          break;

        default:
          debugLogger.debug("AssemblyAI unknown message type", { type: message.type });
      }
    } catch (err) {
      debugLogger.error("AssemblyAI message parse error", { error: err.message });
    }
  }

  normalizeTurnText(text) {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  sendAudio(pcmBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.ws.send(pcmBuffer);
    return true;
  }

  forceEndpoint() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.ws.send(JSON.stringify({ type: "ForceEndpoint" }));
    debugLogger.debug("AssemblyAI ForceEndpoint sent");
    return true;
  }

  async disconnect(terminate = true) {
    if (!this.ws) return { text: this.accumulatedText };

    this.isDisconnecting = true;

    if (terminate && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "Terminate" }));

        let timeoutId;
        const result = await Promise.race([
          new Promise((resolve) => {
            this.terminationResolve = resolve;
          }),
          new Promise((resolve) => {
            timeoutId = setTimeout(() => {
              debugLogger.debug("AssemblyAI termination timeout, using accumulated text");
              resolve({ text: this.accumulatedText });
            }, TERMINATION_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timeoutId);

        this.terminationResolve = null;
        this.cleanup();
        this.isDisconnecting = false;
        return result;
      } catch (err) {
        debugLogger.debug("AssemblyAI terminate send failed", { error: err.message });
      }
    }

    const result = { text: this.accumulatedText };
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  cleanup() {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;

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
    this.terminationResolve = null;
  }

  cleanupAll() {
    this.cleanup();
    this.cleanupWarmConnection();
    clearTimeout(this.rewarmTimer);
    this.rewarmTimer = null;
    this.cachedToken = null;
    this.tokenFetchedAt = null;
    this.warmConnectionOptions = null;
    this.turns = [];
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

module.exports = AssemblyAiStreaming;
