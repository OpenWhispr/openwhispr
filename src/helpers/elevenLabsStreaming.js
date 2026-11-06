const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const { sanitizeKeyterms } = require("./elevenLabsTranscription");

const REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const REALTIME_MODEL = "scribe_v2_realtime";
const SAMPLE_RATE = 24000;
const WEBSOCKET_TIMEOUT_MS = 30000;
// The final commit's transcript; a stop must not hang on a server that never sends it.
const FINAL_COMMIT_TIMEOUT_MS = 4000;
// A VAD commit already in flight can answer the final commit first; a partial
// arriving within this window means later words still wait for their own commit.
const FINAL_COMMIT_SETTLE_MS = 300;
// How long a plain committed_transcript waits for its timestamped twin.
const PLAIN_COMMIT_GRACE_MS = 1500;
// ElevenLabs closes a socket that hears nothing for 15 s. Meeting audio arrives
// continuously, so this only fills gaps such as a paused capture.
const KEEPALIVE_IDLE_MS = 5000;
const KEEPALIVE_SILENCE_MS = 100;
// Keyterms ride in the query string, so the list is kept well short of URL limits.
const MAX_REALTIME_KEYTERMS = 100;

// Errors after which the session cannot continue. The rest are either transient
// (the server closes the socket and the meeting reconnects) or advisory.
const FATAL_ERRORS = new Set([
  "auth_error",
  "quota_exceeded",
  "unaccepted_terms",
  "invalid_request",
]);
const ADVISORY_ERRORS = new Set([
  "commit_throttled",
  "insufficient_audio_activity",
  "chunk_size_exceeded",
]);

function errorWithCode(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function describeServerError(type, detail) {
  switch (type) {
    case "auth_error":
      return errorWithCode(
        "ElevenLabs rejected the API key. Check it in Settings.",
        "PROVIDER_AUTH_FAILED"
      );
    case "quota_exceeded":
      return errorWithCode(
        "Your ElevenLabs quota is used up. Check your plan or usage.",
        "PROVIDER_QUOTA_EXHAUSTED"
      );
    case "unaccepted_terms":
      return errorWithCode(
        "Accept ElevenLabs' speech-to-text terms in your ElevenLabs account first.",
        "PROVIDER_ACCESS_DENIED"
      );
    default:
      return errorWithCode(`ElevenLabs ${type}${detail ? `: ${detail}` : ""}`);
  }
}

// The handshake answers a refused key with an HTTP status before any message.
function describeHandshakeError(error) {
  const status = Number(/Unexpected server response: (\d{3})/.exec(error?.message || "")?.[1]);
  if (status === 401 || status === 403) return describeServerError("auth_error");
  if (status === 429)
    return errorWithCode("ElevenLabs is rate limiting requests.", "PROVIDER_RATE_LIMITED");
  return error;
}

// Scribe v2 Realtime over WSS: xi-api-key header, base64 PCM inside JSON
// input_audio_chunk messages, and server-side VAD commits. Mirrors the
// Corti/Deepgram streaming classes the meeting pipeline drives.
class ElevenLabsStreaming {
  constructor() {
    this.ws = null;
    this.sessionId = null;
    this.isConnected = false;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.onConnectionLost = null;
    this.onSessionExpired = null;
    this.connectionLossNotified = false;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.accumulatedText = "";
    this.completedSegments = [];
    this.pendingCommit = null;
    this.pendingPlainCommit = null;
    this.lastTimestampedCommit = null;
    this.hasUncommittedSpeech = false;
    this.isDisconnecting = false;
    this.preSessionBuffer = [];
    this.preSessionBufferSize = 0;
    this.bufferingAudio = false;
    this.sessionStartedAt = null;
    this.firstAudioAt = null;
    this.audioBytesSent = 0;
    // Audio the server has heard, keep-alive silence included, and the points where
    // that stream jumped ahead of the wall clock (a paused capture filled by silence).
    this.streamMs = 0;
    this.streamAnchors = [];
    this.reanchorOnNextAudio = false;
    this.currentModel = REALTIME_MODEL;
    this.sampleRate = SAMPLE_RATE;
    this.keepAliveInterval = null;
    this.lastSendAt = 0;
    // Server message counts by type, logged when the session ends.
    this.messageCounts = {};
  }

  buildWebSocketUrl(options = {}) {
    const params = new URLSearchParams({
      model_id: REALTIME_MODEL,
      audio_format: `pcm_${this.sampleRate}`,
      commit_strategy: "vad",
      include_timestamps: "true",
    });
    if (options.language && options.language !== "auto") {
      params.set("language_code", options.language);
    }
    for (const term of sanitizeKeyterms(options.keyterms).slice(0, MAX_REALTIME_KEYTERMS)) {
      params.append("keyterms", term);
    }
    return `${REALTIME_URL}?${params}`;
  }

  // Starts holding audio before the socket exists, covering the handshake and the
  // wait for session_started so sendAudio() doesn't drop the first words.
  beginConnecting() {
    this.bufferingAudio = true;
    this.preSessionBuffer = [];
    this.preSessionBufferSize = 0;
  }

  async connect(options = {}) {
    const apiKey = options.apiKey || options.token;
    if (!apiKey) throw new Error("ElevenLabs streaming requires an API key");

    if (this.isConnected) {
      debugLogger.debug("ElevenLabs streaming already connected");
      return;
    }

    this.accumulatedText = "";
    this.completedSegments = [];
    this.hasUncommittedSpeech = false;
    this.messageCounts = {};
    this.connectionLossNotified = false;
    if (!this.bufferingAudio) this.beginConnecting();
    this.audioBytesSent = 0;
    this.streamMs = 0;
    this.streamAnchors = [];
    this.reanchorOnNextAudio = false;
    this.firstAudioAt = null;
    this.sampleRate = options.sampleRate || SAMPLE_RATE;

    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("ElevenLabs streaming connecting", {
      sampleRate: this.sampleRate,
      language: options.language,
      stream: options.streamLabel,
    });

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        this.rejectPending(new Error("ElevenLabs WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      const ws = new WebSocket(url, { headers: { "xi-api-key": apiKey } });
      this.ws = ws;
      this.attachSocketHandlers(ws);
    });
  }

  rejectPending(error) {
    if (!this.pendingReject) return false;
    this.pendingReject(error);
    this.pendingReject = null;
    this.pendingResolve = null;
    return true;
  }

  // A socket that cleanup() already replaced can still deliver a message, error
  // or close; those events must not touch the session now using this.ws.
  attachSocketHandlers(ws) {
    ws.on("message", (data) => {
      if (ws !== this.ws) return;
      this.handleMessage(data);
    });

    ws.on("error", (rawError) => {
      if (ws !== this.ws) return;
      const error = describeHandshakeError(rawError);
      const wasActive = this.isConnected;
      debugLogger.error("ElevenLabs WebSocket error", { error: rawError.message });
      this.cleanup();
      if (this.rejectPending(error)) return;
      if (wasActive && !this.isDisconnecting) {
        this.notifyConnectionLost(error);
      } else if (!this.isDisconnecting) {
        this.onError?.(error);
      }
    });

    ws.on("close", (code, reason) => {
      if (ws !== this.ws) return;
      const wasActive = this.isConnected;
      debugLogger.debug("ElevenLabs WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      this.rejectPending(new Error(`ElevenLabs WebSocket closed before ready (code: ${code})`));
      this.cleanup();
      if (wasActive && !this.isDisconnecting) {
        this.notifyConnectionLost(new Error(`Connection lost (code: ${code})`));
      }
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
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      debugLogger.error("ElevenLabs message parse error", { error: err.message });
      return;
    }

    const type = message.message_type;
    this.messageCounts[type] = (this.messageCounts[type] || 0) + 1;
    if (type?.startsWith("committed_transcript")) {
      debugLogger.debug("ElevenLabs commit received", {
        type,
        chars: (message.text || "").trim().length,
        words: Array.isArray(message.words) ? message.words.length : undefined,
      });
    }
    switch (type) {
      case "session_started":
        this.isConnected = true;
        this.sessionId = message.session_id || null;
        // Word times count from the first sample sent, which may have been held
        // while the socket opened.
        this.sessionStartedAt = this.firstAudioAt ?? Date.now();
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;
        this.flushPreSessionBuffer();
        this.startKeepAlive();
        debugLogger.debug("ElevenLabs session started", {
          sessionId: this.sessionId,
          model: message.config?.model_id,
        });
        if (this.pendingResolve) {
          this.pendingResolve();
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        break;

      case "partial_transcript":
        if (message.text) {
          this.hasUncommittedSpeech = true;
          this.onPartialTranscript?.(message.text);
        }
        break;

      case "committed_transcript_with_timestamps":
        // Cleared on arrival: a partial that comes after this belongs to the next commit.
        this.hasUncommittedSpeech = false;
        this.clearPendingPlainCommit();
        this.lastTimestampedCommit = { text: (message.text || "").trim(), at: Date.now() };
        this.commitSegment(message.text, this.timestampFromWords(message.words));
        break;

      // Sent beside the timestamped commit; it only stands in if that never comes.
      case "committed_transcript":
        this.hasUncommittedSpeech = false;
        this.clearPendingPlainCommit();
        if (this.isEchoOfTimestampedCommit(message.text)) break;
        if (!message.text?.trim()) {
          this.commitSegment("", null);
          break;
        }
        this.pendingPlainCommit = {
          text: message.text,
          timer: setTimeout(() => this.emitPendingPlainCommit(), PLAIN_COMMIT_GRACE_MS),
        };
        break;

      case "session_time_limit_exceeded":
        if (this.isDisconnecting) break;
        debugLogger.warn("ElevenLabs session time limit reached", { error: message.error });
        // The session takes no more audio, so the meeting keeps it for the replacement,
        // and the close that follows is not a second loss.
        this.isConnected = false;
        this.connectionLossNotified = true;
        if (this.onSessionExpired) {
          this.onSessionExpired({ proactive: false });
        } else {
          this.notifyConnectionLost(describeServerError(type, message.error));
        }
        break;

      case "warning":
        debugLogger.debug("ElevenLabs warning", { warning: message.warning });
        break;

      case "committed_transcript_entities":
      case "edited_transcript":
        break;

      default:
        if (type === "error" || type?.endsWith("_error") || message.error) {
          this.handleServerError(type, message.error);
        } else {
          debugLogger.debug("ElevenLabs unknown message type", { type });
        }
    }
  }

  handleServerError(type, detail) {
    if (ADVISORY_ERRORS.has(type)) {
      debugLogger.debug("ElevenLabs advisory error", { type, detail });
      return;
    }
    const error = describeServerError(type, detail);
    debugLogger.error("ElevenLabs streaming error", { type, detail });
    if (this.rejectPending(error)) {
      this.cleanup();
      return;
    }
    // Transient failures end with the server closing the socket, which reconnects.
    // A fatal one would fail every reconnect the same way, so it is reported as a
    // loss the meeting must not retry; the close that follows adds nothing.
    if (FATAL_ERRORS.has(type)) {
      error.fatal = true;
      this.notifyConnectionLost(error);
    }
  }

  // Word times count along the audio the server heard. Keep-alive silence adds
  // only a little of it for a long pause, so times after a pause are taken from
  // where real audio resumed.
  timestampFromWords(words) {
    if (this.sessionStartedAt == null || !Array.isArray(words)) return null;
    const first = words.find((word) => word?.type !== "spacing" && typeof word?.start === "number");
    if (!first) return null;
    const startMs = first.start * 1000;
    let anchor = { offsetMs: 0, at: this.sessionStartedAt };
    for (const candidate of this.streamAnchors) {
      if (candidate.offsetMs > startMs) break;
      anchor = candidate;
    }
    return anchor.at + (startMs - anchor.offsetMs);
  }

  bytesToMs(bytes) {
    return (bytes / 2 / this.sampleRate) * 1000;
  }

  commitSegment(text, timestamp) {
    const trimmed = (text || "").trim();
    if (trimmed) {
      this.completedSegments.push(trimmed);
      this.accumulatedText = this.completedSegments.join(" ");
      this.onFinalTranscript?.(this.accumulatedText, timestamp ?? Date.now());
    }
    this.resolvePendingCommit();
  }

  // The same commit's plain copy, arriving after its timestamped twin.
  isEchoOfTimestampedCommit(text) {
    const last = this.lastTimestampedCommit;
    return (
      !!last && Date.now() - last.at < PLAIN_COMMIT_GRACE_MS && last.text === (text || "").trim()
    );
  }

  emitPendingPlainCommit() {
    const pending = this.pendingPlainCommit;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingPlainCommit = null;
    this.commitSegment(pending.text, null);
  }

  clearPendingPlainCommit() {
    if (!this.pendingPlainCommit) return;
    clearTimeout(this.pendingPlainCommit.timer);
    this.pendingPlainCommit = null;
  }

  sendChunk(pcmBuffer, commit = false) {
    this.ws.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: pcmBuffer.toString("base64"),
        commit,
        sample_rate: this.sampleRate,
      })
    );
    this.lastSendAt = Date.now();
  }

  flushPreSessionBuffer() {
    this.bufferingAudio = false;
    if (this.preSessionBuffer.length === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    debugLogger.debug("ElevenLabs flushing pre-session buffer", {
      chunks: this.preSessionBuffer.length,
      bytes: this.preSessionBufferSize,
    });
    for (const chunk of this.preSessionBuffer) {
      this.sendChunk(chunk);
      this.audioBytesSent += chunk.length;
      this.streamMs += this.bytesToMs(chunk.length);
    }
    this.preSessionBuffer = [];
    this.preSessionBufferSize = 0;
  }

  sendAudio(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length === 0) return false;
    if (!this.isConnected) {
      // Hold up to ~3 s while the session opens.
      if (!this.bufferingAudio || this.preSessionBufferSize >= 3 * this.sampleRate * 2) {
        return false;
      }
      const copy = Buffer.from(pcmBuffer);
      this.firstAudioAt ??= Date.now();
      this.preSessionBuffer.push(copy);
      this.preSessionBufferSize += copy.length;
      return true;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    this.firstAudioAt ??= Date.now();
    if (this.reanchorOnNextAudio) {
      this.reanchorOnNextAudio = false;
      this.streamAnchors.push({ offsetMs: this.streamMs, at: Date.now() });
    }
    this.audioBytesSent += pcmBuffer.length;
    this.streamMs += this.bytesToMs(pcmBuffer.length);
    this.sendChunk(Buffer.from(pcmBuffer));
    return true;
  }

  // Commits whatever has been heard since the last VAD commit.
  finalize() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isConnected) return false;
    this.sendChunk(Buffer.alloc(0), true);
    debugLogger.debug("ElevenLabs commit sent");
    return true;
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.lastSendAt = Date.now();
    this.keepAliveInterval = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN || !this.isConnected) return;
      if (Date.now() - this.lastSendAt < KEEPALIVE_IDLE_MS) return;
      const silence = Buffer.alloc(Math.round((this.sampleRate * KEEPALIVE_SILENCE_MS) / 1000) * 2);
      try {
        this.sendChunk(silence);
        this.streamMs += KEEPALIVE_SILENCE_MS;
        this.reanchorOnNextAudio = true;
      } catch (err) {
        debugLogger.debug("ElevenLabs keep-alive failed", { error: err.message });
      }
    }, 1000);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  resolvePendingCommit(committed = true) {
    if (!this.pendingCommit) return;
    clearTimeout(this.pendingCommit.timer);
    this.pendingCommit.resolve(committed);
    this.pendingCommit = null;
  }

  // Resolves true on the next emitted commit, false on timeout or cleanup.
  waitForCommit(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCommit = null;
        resolve(false);
      }, timeoutMs);
      this.pendingCommit = { resolve, timer };
    });
  }

  // Waits until every word heard has been committed, or the deadline passes.
  async waitForFinalCommits() {
    const deadline = Date.now() + FINAL_COMMIT_TIMEOUT_MS;
    while (this.hasUncommittedSpeech || this.pendingPlainCommit) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await this.waitForCommit(remaining))) return;
      const settle = Math.min(FINAL_COMMIT_SETTLE_MS, deadline - Date.now());
      if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle));
      if (!this.isConnected) return;
    }
  }

  async disconnect(closeStream = true) {
    const cancelled = new Error("ElevenLabs streaming was stopped before it started");
    if (!this.ws) {
      // A stop before the socket exists must not leave the start's held audio behind.
      this.cleanup();
      this.rejectPending(cancelled);
      return { text: this.accumulatedText };
    }

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN && this.isConnected) {
      // Commit the trailing words and wait for their transcript before closing. A
      // plain commit still waiting for its timestamped twin is waited for too.
      if (this.hasUncommittedSpeech) this.finalize();
      await this.waitForFinalCommits();
      this.emitPendingPlainCommit();
      const result = { text: this.accumulatedText };
      this.onSessionEnd?.(result);
      this.cleanup();
      this.isDisconnecting = false;
      return result;
    }

    this.emitPendingPlainCommit();
    const result = { text: this.accumulatedText };
    this.cleanup();
    this.rejectPending(cancelled);
    this.isDisconnecting = false;
    return result;
  }

  cleanup() {
    if (this.sessionId) {
      debugLogger.debug("ElevenLabs session closing", {
        sessionId: this.sessionId,
        audioSeconds: Math.round(this.streamMs / 1000),
        messages: this.messageCounts,
      });
    }
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.clearPendingPlainCommit();
    this.stopKeepAlive();
    this.preSessionBuffer = [];
    this.preSessionBufferSize = 0;
    this.bufferingAudio = false;

    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch (err) {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.sessionId = null;
    this.resolvePendingCommit(false);
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      sessionId: this.sessionId,
    };
  }
}

module.exports = ElevenLabsStreaming;
