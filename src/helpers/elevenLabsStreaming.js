const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const { sanitizeKeyterms, SILENCE_MARKER } = require("./elevenLabsTranscription");

const REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const REALTIME_MODEL = "scribe_v3_live";
const SAMPLE_RATE = 24000;
const WEBSOCKET_TIMEOUT_MS = 30000;
// The final commit's transcript; a stop must not hang on a server that never sends it.
const FINAL_COMMIT_TIMEOUT_MS = 4000;
// How long a plain committed_transcript waits for its timestamped twin.
const PLAIN_COMMIT_GRACE_MS = 1500;
// ElevenLabs closes a socket that hears nothing for 15 s. Meeting audio arrives
// continuously, so this only fills gaps such as a paused capture.
const KEEPALIVE_IDLE_MS = 5000;
const KEEPALIVE_SILENCE_MS = 100;
// A final commit for audio the server has shown no words for is answered quickly
// or not at all, so a stop waits only this long for it.
const QUIET_COMMIT_TIMEOUT_MS = 1000;
// The realtime endpoint takes fewer and shorter keyterms than the batch one.
const MAX_REALTIME_KEYTERMS = 50;
const MAX_REALTIME_KEYTERM_CHARS = 20;

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

function firstWordOffsetMs(words) {
  if (!Array.isArray(words)) return null;
  const first = words.find((word) => word?.type !== "spacing" && typeof word?.start === "number");
  return first ? first.start * 1000 : null;
}

// Scribe v3 Live over WSS: xi-api-key header, base64 PCM inside JSON
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
    this.plainCommitsAwaitingTimestamps = [];
    this.currentPartial = "";
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
    const keyterms = sanitizeKeyterms(
      options.keyterms,
      MAX_REALTIME_KEYTERMS,
      MAX_REALTIME_KEYTERM_CHARS
    );
    for (const term of keyterms) params.append("keyterms", term);
    return `${REALTIME_URL}?${params}`;
  }

  // Starts holding audio before the socket exists, covering the handshake and the
  // wait for session_started so sendAudio() doesn't drop the first words.
  beginConnecting() {
    this.firstAudioAt = null;
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
    this.currentPartial = "";
    this.lastTimestampedCommit = null;
    this.plainCommitsAwaitingTimestamps = [];
    this.messageCounts = {};
    this.connectionLossNotified = false;
    if (!this.bufferingAudio) this.beginConnecting();
    this.audioBytesSent = 0;
    this.streamMs = 0;
    this.streamAnchors = [];
    this.reanchorOnNextAudio = false;
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
      this.emitPendingPlainCommit();
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
      this.emitPendingPlainCommit();
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
        this.currentPartial = message.text?.trim() === SILENCE_MARKER ? "" : message.text || "";
        this.onPartialTranscript?.(this.currentPartial);
        break;

      case "committed_transcript":
      case "committed_transcript_with_timestamps":
        this.receiveCommit(message, type === "committed_transcript_with_timestamps");
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
  timeAtAudioOffset(offsetMs) {
    if (this.sessionStartedAt == null) return null;
    let anchor = { offsetMs: 0, at: this.sessionStartedAt };
    for (const candidate of this.streamAnchors) {
      if (candidate.offsetMs > offsetMs) break;
      anchor = candidate;
    }
    return anchor.at + (offsetMs - anchor.offsetMs);
  }

  bytesToMs(bytes) {
    return (bytes / 2 / this.sampleRate) * 1000;
  }

  receiveCommit(message, timestamped) {
    const text = (message.text || "").trim();
    const startMs = firstWordOffsetMs(message.words);
    const timestamp = startMs === null ? null : this.timeAtAudioOffset(startMs);
    if (timestamped) {
      // Matching words in newer audio belong to a new utterance, even if an
      // earlier plain commit with the same text never received its timestamps.
      const matches = (plain) =>
        plain?.text === text &&
        (startMs === null || plain.audioEndMs === this.streamMs || startMs < plain.audioEndMs);
      const emitted = this.plainCommitsAwaitingTimestamps.findIndex(matches);
      if (emitted >= 0) {
        this.plainCommitsAwaitingTimestamps.splice(emitted, 1);
        return;
      }
      if (matches(this.pendingPlainCommit)) {
        const fallbackTimestamp = this.pendingPlainCommit.timestamp;
        this.clearPendingPlainCommit();
        this.commitSegment(text, timestamp ?? fallbackTimestamp);
        return;
      }
    }

    const previous = this.lastTimestampedCommit;
    const possibleReverseTwin =
      !timestamped && previous?.text === text && Date.now() - previous.at < PLAIN_COMMIT_GRACE_MS;
    if (possibleReverseTwin) {
      // The same words may have been spoken again. A matching new partial in
      // newer audio lets the plain final stand in if those timestamps never arrive.
      const partial = this.currentPartial.trim().toLowerCase();
      if (
        this.audioBytesSent === previous.audioBytesSent ||
        !partial ||
        !text.toLowerCase().startsWith(partial)
      ) {
        this.lastTimestampedCommit = null;
        return;
      }
    }

    // Only the first event for a segment closes its partial. Its twin can arrive
    // after the user has started the next utterance.
    this.currentPartial = "";
    this.emitPendingPlainCommit();
    if (timestamped) {
      this.lastTimestampedCommit = { text, at: Date.now(), audioBytesSent: this.audioBytesSent };
    } else if (!possibleReverseTwin) {
      this.lastTimestampedCommit = null;
    }
    if (!text || text === SILENCE_MARKER) this.onPartialTranscript?.("");
    // Without word times, place the segment at the last sample available when the
    // commit arrived. Waiting for its twin must not move the segment past later audio.
    const lastSampleMs = Math.max(0, this.streamMs - this.bytesToMs(2));
    const fallbackTimestamp = this.timeAtAudioOffset(lastSampleMs) ?? Date.now();
    if (timestamped) {
      this.commitSegment(text, timestamp ?? fallbackTimestamp);
    } else {
      this.pendingPlainCommit = {
        text,
        timestamp: fallbackTimestamp,
        audioEndMs: this.streamMs,
        timer: setTimeout(() => this.emitPendingPlainCommit(), PLAIN_COMMIT_GRACE_MS),
      };
    }
  }

  commitSegment(text, timestamp) {
    if (text && text !== SILENCE_MARKER) {
      this.completedSegments.push(text);
      this.accumulatedText = this.completedSegments.join(" ");
      this.onFinalTranscript?.(this.accumulatedText, timestamp);
      // The renderer clears the live partial on each final, including a delayed one.
      if (this.currentPartial) this.onPartialTranscript?.(this.currentPartial);
    }
    this.resolvePendingCommit();
  }

  emitPendingPlainCommit() {
    if (!this.pendingPlainCommit) return;
    const { text, timestamp, audioEndMs } = this.pendingPlainCommit;
    this.clearPendingPlainCommit();
    this.plainCommitsAwaitingTimestamps.push({ text, audioEndMs });
    this.commitSegment(text, timestamp);
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

  sendAudio(pcmBuffer, capturedAt = null) {
    if (!pcmBuffer || pcmBuffer.length === 0) return false;
    if (!this.isConnected) {
      // Hold up to ~3 s while the session opens.
      if (!this.bufferingAudio || this.preSessionBufferSize >= 3 * this.sampleRate * 2) {
        return false;
      }
      const copy = Buffer.from(pcmBuffer);
      this.firstAudioAt ??= capturedAt ?? Date.now();
      this.preSessionBuffer.push(copy);
      this.preSessionBufferSize += copy.length;
      return true;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;

    if (this.firstAudioAt === null) {
      this.firstAudioAt = capturedAt ?? Date.now();
      this.sessionStartedAt = this.firstAudioAt;
    }
    if (this.reanchorOnNextAudio) {
      this.reanchorOnNextAudio = false;
      this.streamAnchors.push({ offsetMs: this.streamMs, at: capturedAt ?? Date.now() });
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

  async waitForFinalCommits(requestedCommit) {
    if (!requestedCommit) {
      if (this.pendingPlainCommit) await this.waitForCommit(PLAIN_COMMIT_GRACE_MS);
      return;
    }

    const deadline = Date.now() + FINAL_COMMIT_TIMEOUT_MS;
    if (!this.currentPartial && !this.pendingPlainCommit) {
      const heardCommit = await this.waitForCommit(QUIET_COMMIT_TIMEOUT_MS);
      if (!heardCommit && !this.currentPartial && !this.pendingPlainCommit) return;
    }

    // Scribe does not label the response to our explicit commit. Any response
    // could be an older VAD segment, so drain to the original deadline.
    while (this.isConnected) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await this.waitForCommit(remaining))) return;
    }
  }

  async disconnect({ commit = true } = {}) {
    const cancelled = new Error("ElevenLabs streaming was stopped before it started");
    if (!this.ws) {
      // A stop before the socket exists must not leave the start's held audio behind.
      this.cleanup();
      this.rejectPending(cancelled);
      return { text: this.accumulatedText };
    }

    this.isDisconnecting = true;

    if (commit && this.ws.readyState === WebSocket.OPEN && this.isConnected) {
      // A VAD response acknowledges a segment, not all audio sent before it arrived.
      // Commit even without a partial, since the last samples may still be in flight.
      const requestedCommit = Boolean(this.currentPartial || this.audioBytesSent > 0);
      if (requestedCommit) this.finalize();
      await this.waitForFinalCommits(requestedCommit);
      this.emitPendingPlainCommit();
      const result = { text: this.accumulatedText };
      this.onSessionEnd?.(result);
      this.cleanup();
      this.isDisconnecting = false;
      return result;
    }

    // A caller that asked for no commit takes nothing more from this session.
    if (commit) this.emitPendingPlainCommit();
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
