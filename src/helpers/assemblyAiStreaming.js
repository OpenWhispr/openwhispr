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
const WARM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const COLD_START_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 seconds of 16-bit PCM
const MIN_FRAME_MS = 50;
// AssemblyAI hard-closes the session outside 50-1000 ms but documents 50-250 ms
// as the supported shape, so the split targets the recommended ceiling: 1000 would
// put the first slice of a coalesced read exactly on the limit it exists to avoid.
const MAX_FRAME_MS = 250;
// Both bounds follow the rate the socket opened at: Note Recording streams at
// 24 kHz, where a frame sized against this module's 16 kHz default lasts only
// 33 ms (#2140).
const minFrameBytes = (sampleRate) => Math.ceil((sampleRate * 2 * MIN_FRAME_MS) / 1000);
const maxFrameBytes = (sampleRate) => Math.floor((sampleRate * 2 * MAX_FRAME_MS) / 1000);

class AssemblyAiStreaming {
  constructor(options = {}) {
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.onConnectionLost = null;
    this.connectionLossNotified = false;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.accumulatedText = "";
    this.lastTurnText = "";
    this.turns = [];
    this.terminationResolve = null;
    this.cachedToken = null;
    this.tokenFetchedAt = null;
    this.mode = null;
    this.warmConnection = null;
    this.warmConnectionReady = false;
    this.warmConnectionOptions = null;
    this.warmSessionId = null;
    this.requestedModel = null;
    this.sessionSampleRate = SAMPLE_RATE;
    this.rewarmAttempts = 0;
    this.rewarmTimer = null;
    this.keepAliveInterval = null;
    this.warmIdleTimer = null;
    this.warmIdleTimeoutMs = options?.warmIdleTimeoutMs ?? WARM_IDLE_TIMEOUT_MS;
    this.warmIdleExpiresAt = null;
    this.isDisconnecting = false;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.bufferingAudio = false;
    this.completedSegments = [];
    this.speechStartedAt = null;
  }

  buildWebSocketUrl(options) {
    const sampleRate = options.sampleRate || SAMPLE_RATE;
    this.sessionSampleRate = sampleRate;
    const params = new URLSearchParams({
      sample_rate: String(sampleRate),
      encoding: "pcm_s16le",
      format_turns: "true",
      token: options.token,
    });
    this.requestedModel = options.model || null;
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

  // BYOK and managed dictation share one client instance, so a token or warm
  // socket minted under one credential kind must never serve the other. Callers
  // that read the cache before connecting must adopt the mode first.
  adoptMode(options) {
    const mode = options.mode === "byok" ? "byok" : "openwhispr";
    if (this.mode !== null && this.mode !== mode) {
      debugLogger.debug("AssemblyAI credential mode changed, dropping cached session state", {
        from: this.mode,
        to: mode,
      });
      this.cachedToken = null;
      this.tokenFetchedAt = null;
      this.cleanupWarmConnection();
    }
    this.mode = mode;
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

  startWarmIdleTimer(timeoutMs = this.warmIdleTimeoutMs) {
    this.stopWarmIdleTimer();
    const effectiveTimeout = timeoutMs !== undefined ? timeoutMs : WARM_IDLE_TIMEOUT_MS;
    if (effectiveTimeout === null || effectiveTimeout <= 0) {
      return;
    }
    this.warmIdleTimeoutMs = effectiveTimeout;
    this.warmIdleExpiresAt = Date.now() + effectiveTimeout;
    this.warmIdleTimer = setTimeout(() => {
      this.warmIdleTimer = null;
      this.warmIdleExpiresAt = null;
      debugLogger.debug("AssemblyAI warm connection idle timeout reached, closing connection");
      this.cleanupWarmConnection();
    }, effectiveTimeout);
  }

  stopWarmIdleTimer() {
    if (this.warmIdleTimer) {
      clearTimeout(this.warmIdleTimer);
      this.warmIdleTimer = null;
    }
    this.warmIdleExpiresAt = null;
  }

  resetWarmIdleTimer(timeoutMs = this.warmIdleTimeoutMs) {
    if (this.hasWarmConnection()) {
      this.startWarmIdleTimer(timeoutMs);
    }
  }

  async warmup(options = {}) {
    const { token } = options;
    if (!token) {
      throw new Error("Streaming token is required for warmup");
    }

    this.adoptMode(options);
    if (this.warmConnection) {
      if (this.warmConnectionReady) {
        this.resetWarmIdleTimer(options.idleTimeoutMs);
      }
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
      let settled = false;
      const socket = new WebSocket(url);
      this.warmConnection = socket;

      const warmupTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this.warmConnection === socket) this.cleanupWarmConnection();
        reject(new Error("AssemblyAI warmup connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      socket.on("open", () => {
        debugLogger.debug("AssemblyAI warm connection socket opened");
      });

      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "Begin" && !settled) {
            settled = true;
            clearTimeout(warmupTimeout);
            this.warmConnectionReady = true;
            this.warmSessionId = message.id || null;
            this.startKeepAlive();
            this.startWarmIdleTimer(options.idleTimeoutMs);
            debugLogger.debug("AssemblyAI connection warmed up", { sessionId: message.id });
            resolve();
          }
        } catch (err) {
          debugLogger.error("AssemblyAI warmup message parse error", { error: err.message });
        }
      });

      socket.on("error", (error) => {
        clearTimeout(warmupTimeout);
        debugLogger.error("AssemblyAI warmup connection error", { error: error.message });
        if (this.warmConnection === socket) this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.on("close", (code, reason) => {
        clearTimeout(warmupTimeout);
        // A dropped socket closes after its replacement may have opened; leave that one be.
        if (this.warmConnection !== socket) {
          if (!settled) {
            settled = true;
            reject(new Error(`AssemblyAI warmup connection closed before ready (code: ${code})`));
          }
          return;
        }
        this.stopKeepAlive();
        this.stopWarmIdleTimer();
        const wasReady = this.warmConnectionReady;
        const savedOptions = this.warmConnectionOptions ? { ...this.warmConnectionOptions } : null;
        const isIdleExpired = this.warmIdleExpiresAt && Date.now() >= this.warmIdleExpiresAt;
        debugLogger.debug("AssemblyAI warm connection closed", {
          wasReady,
          code,
          reason: reason?.toString(),
        });
        this.cleanupWarmConnection();
        if (!settled) {
          settled = true;
          reject(new Error(`AssemblyAI warmup connection closed before ready (code: ${code})`));
          return;
        }
        if (wasReady && savedOptions && !isIdleExpired) {
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
    if (this.warmIdleExpiresAt && Date.now() >= this.warmIdleExpiresAt) {
      debugLogger.debug("AssemblyAI warm connection idle window expired, skipping re-warm");
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
      if (this.warmIdleExpiresAt && Date.now() >= this.warmIdleExpiresAt) return;
      const remainingTimeout = this.warmIdleExpiresAt
        ? Math.max(1, this.warmIdleExpiresAt - Date.now())
        : undefined;
      this.warmup({ ...this.warmConnectionOptions, token, idleTimeoutMs: remainingTimeout }).catch(
        (err) => {
          debugLogger.debug("AssemblyAI auto re-warm failed", { error: err.message });
        }
      );
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
    this.stopWarmIdleTimer();
    clearTimeout(this.rewarmTimer);
    this.rewarmTimer = null;
    this.rewarmAttempts = 0;

    this.ws = this.warmConnection;
    this.isConnected = true;
    this.connectionLossNotified = false;
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
      const wasActive = this.isConnected;
      debugLogger.error("AssemblyAI WebSocket error", { error: error.message });
      this.cleanup();
      if (wasActive && !this.isDisconnecting) this.notifyConnectionLost(error);
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
        this.notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
      }
    });

    debugLogger.debug("AssemblyAI using pre-warmed connection");
    return true;
  }

  cleanupWarmConnection() {
    this.stopKeepAlive();
    this.stopWarmIdleTimer();
    clearTimeout(this.rewarmTimer);
    this.rewarmTimer = null;
    if (this.warmConnection) {
      const socket = this.warmConnection;
      this.warmConnection = null;
      try {
        socket.close();
      } catch (err) {
        // Ignore
      }
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

  // Starts holding audio before the socket exists, covering the token fetch and
  // the handshake so sendAudio() doesn't drop the first words.
  beginConnecting() {
    this.bufferingAudio = true;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
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
    this.connectionLossNotified = false;
    // The caller may already be holding audio from before its token fetch.
    if (!this.bufferingAudio) this.beginConnecting();

    this.adoptMode(options);
    // The server pins speech_model at Begin, so a warm socket opened for another
    // model would keep that model for the whole session — and the Begin mismatch
    // warning could never fire for the model actually requested.
    if (
      this.hasWarmConnection() &&
      ((this.warmConnectionOptions.model || null) !== (options.model || null) ||
        (this.warmConnectionOptions.sampleRate || SAMPLE_RATE) !==
          (options.sampleRate || SAMPLE_RATE))
    ) {
      debugLogger.debug("AssemblyAI warm connection differs, cold-starting", {
        warm: this.warmConnectionOptions.model || null,
        requested: options.model || null,
        warmSampleRate: this.warmConnectionOptions.sampleRate || SAMPLE_RATE,
        requestedSampleRate: options.sampleRate || SAMPLE_RATE,
      });
      this.cleanupWarmConnection();
    }

    // Try to use pre-warmed connection for instant start
    if (this.hasWarmConnection()) {
      if (this.useWarmConnection()) {
        debugLogger.debug("AssemblyAI using warm connection - instant start");
        this.sendPendingAudio();
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
        const wasActive = this.isConnected;
        debugLogger.error("AssemblyAI WebSocket error", { error: error.message });
        this.cleanup();
        if (this.pendingReject) {
          this.pendingReject(error);
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        if (wasActive && !this.isDisconnecting) {
          this.notifyConnectionLost(error);
        } else if (!this.isDisconnecting) {
          this.onError?.(error);
        }
      });

      this.ws.on("close", (code, reason) => {
        const wasActive = this.isConnected;
        debugLogger.debug("AssemblyAI WebSocket closed", {
          code,
          reason: reason?.toString(),
          wasActive,
        });
        if (this.pendingReject) {
          this.pendingReject(new Error(`AssemblyAI WebSocket closed before ready (code: ${code})`));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        this.cleanup();
        if (wasActive && !this.isDisconnecting) {
          this.notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
        }
      });
    });
  }

  notifyConnectionLost(error) {
    if (this.connectionLossNotified) return;
    this.connectionLossNotified = true;
    if (this.onConnectionLost) {
      this.onConnectionLost(error);
    } else {
      this.onError?.(error);
    }
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
          // AssemblyAI ignores unrecognized query params instead of rejecting them,
          // so a bad speech_model silently downgrades the session.
          if (
            message.configuration?.model &&
            this.requestedModel &&
            message.configuration.model !== this.requestedModel
          ) {
            debugLogger.warn(
              "AssemblyAI applied a different speech model than requested",
              { requested: this.requestedModel, applied: message.configuration.model },
              "transcription"
            );
          }
          // Audio held through the handshake goes out now: a short dictation may
          // send no further frame to carry it.
          this.sendPendingAudio();
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
                  this.completedSegments[this.completedSegments.length - 1] = trimmedTranscript;
                  this.lastTurnText = trimmedTranscript;
                  this.accumulatedText = this.turns.map((turn) => turn.text).join(" ");
                  this.onFinalTranscript?.(this.accumulatedText, previousTurn.startedAt);
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

              const speechTimestamp = this.speechStartedAt || Date.now();
              this.speechStartedAt = null;
              this.turns.push({
                text: trimmedTranscript,
                normalized: normalizedTranscript,
                startedAt: speechTimestamp,
              });
              this.completedSegments.push(trimmedTranscript);
              this.lastTurnText = trimmedTranscript;
              this.accumulatedText = this.turns.map((turn) => turn.text).join(" ");
              this.onFinalTranscript?.(this.accumulatedText, speechTimestamp);
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

        case "SpeechStarted":
          this.speechStartedAt = Date.now();
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
      // Held only while a start is in flight (up to three seconds), then framed like live audio.
      if (
        !this.bufferingAudio ||
        this.isConnected ||
        this.pendingAudioBytes >= COLD_START_BUFFER_MAX
      ) {
        return false;
      }
      this.pendingAudio.push(Buffer.from(pcmBuffer));
      this.pendingAudioBytes += pcmBuffer.length;
      return true;
    }

    this.pendingAudio.push(pcmBuffer);
    this.pendingAudioBytes += pcmBuffer.length;
    this.sendPendingAudio();
    return true;
  }

  sendPendingAudio() {
    const minBytes = minFrameBytes(this.sessionSampleRate);
    if (this.pendingAudioBytes < minBytes) {
      return;
    }

    const frame = Buffer.concat(this.pendingAudio, this.pendingAudioBytes);
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;

    // The native system-audio helpers forward raw stdout chunks, so one read can
    // far exceed the nominal 100 ms when a stalled main process lets the pipe
    // coalesce. Carry a sub-floor remainder forward rather than sending it short.
    const maxBytes = maxFrameBytes(this.sessionSampleRate);
    let offset = 0;
    while (frame.length - offset >= minBytes) {
      const end = Math.min(offset + maxBytes, frame.length);
      this.ws.send(frame.subarray(offset, end));
      offset = end;
    }
    if (offset < frame.length) {
      const remainder = frame.subarray(offset);
      this.pendingAudio.push(remainder);
      this.pendingAudioBytes = remainder.length;
    }
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

    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.bufferingAudio = false;
    this.completedSegments = [];
    this.speechStartedAt = null;

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
