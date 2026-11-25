const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const {
  PROVIDER_ERROR_CODES,
  asProviderError,
  providerError,
  providerHttpError,
} = require("./providerHttpErrors");
const { SPEECH_FRAME_RMS, computePcm16Rms } = require("../utils/audioUtils");
const { sanitizeElevenLabsKeyterms } = require("../utils/elevenLabsKeyterms.js");
const { SCRIBE_SILENCE_MARKER } = require("../utils/scribeSilence.js");

const REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const REALTIME_MODEL = "scribe_v3_live";
const SAMPLE_RATE = 24000;
const WEBSOCKET_TIMEOUT_MS = 30000;
// The VAD's default 1.5 s is more silence than a fluent speaker leaves. At 0.8 s a
// final came 1.1 to 1.4 s after the speech ended.
const VAD_SILENCE_SECS = 0.8;
// ElevenLabs asks for chunks of 0.1 to 1 s and closed a session that was sent a
// reconnect replay frame by frame, so audio is queued and leaves one message a tick.
const SEND_INTERVAL_MS = 100;
const MAX_CHUNK_MS = 1000;
// The server commits a segment itself after about 35 s without a commit, silence
// included, and the word under that cut was lost. So the client commits in the first
// 0.2 s pause after 20 s; speech with no such pause in the next 15 s gets the cut.
const COMMIT_AFTER_MS = 20000;
const COMMIT_PAUSE_MS = 200;
// A commit with no audio in it closed the session when under 0.3 s had arrived since
// the last one. One carrying this much silence was never refused.
const COMMIT_SILENCE_MS = 350;
// How long a commit's answer is waited for; the slowest live took 1.2 s.
const COMMIT_ACK_TIMEOUT_MS = 2000;
// Committed transcripts carry no id and the VAD sends empty ones of its own, so a
// stop sends three commits and ends at the second empty answer in a row.
const STOP_COMMITS = 3;
// Behind a backlog the server took up to 103 ms per second of audio flushed.
const BACKLOG_TIMEOUT_MS_PER_SECOND = 150;
// A capture time this far past where the audio before it ended means the caller left
// audio out in between. Capture times of a replayed microphone jitter by less.
const CAPTURE_HOLE_MS = 500;
// How long a plain committed_transcript waits for its timestamped twin.
const PLAIN_COMMIT_GRACE_MS = 1500;
// ElevenLabs closes a socket that hears nothing for 15 s. Meeting audio arrives
// continuously, so this only fills gaps such as a paused capture.
const KEEPALIVE_IDLE_MS = 5000;
const KEEPALIVE_SILENCE_MS = 100;
const KEEPALIVE_POLL_MS = 1000;
// The realtime endpoint takes fewer and shorter keyterms than the batch one.
const MAX_REALTIME_KEYTERMS = 50;
const MAX_REALTIME_KEYTERM_CHARS = 20;

const C = PROVIDER_ERROR_CODES;
const ERROR_CONTEXT = { provider: "ElevenLabs", surface: "transcription" };

// Errors after which the session cannot continue. The rest are either transient
// (the server closes the socket and the meeting reconnects) or advisory.
const FATAL_ERROR_CODES = new Map([
  ["auth_error", C.AUTH_FAILED],
  ["quota_exceeded", C.QUOTA_EXHAUSTED],
  ["unaccepted_terms", C.ACCESS_DENIED],
  ["invalid_request", C.BAD_REQUEST],
]);
const TRANSIENT_ERROR_CODES = new Map([
  ["rate_limited", C.RATE_LIMITED],
  ["queue_overflow", C.UNAVAILABLE],
]);
const ADVISORY_ERRORS = new Set([
  "commit_throttled",
  "insufficient_audio_activity",
  "chunk_size_exceeded",
]);

function serverError(type) {
  // No shared message says what to do about this one.
  if (type === "unaccepted_terms") {
    return Object.assign(
      new Error("Accept ElevenLabs' speech-to-text terms in your ElevenLabs account first."),
      { code: C.ACCESS_DENIED }
    );
  }
  const code = FATAL_ERROR_CODES.get(type) ?? TRANSIENT_ERROR_CODES.get(type) ?? C.ERROR;
  return providerError(code, ERROR_CONTEXT);
}

// ws reports a refused upgrade only in its error's message.
function socketError(error) {
  const status = Number(/Unexpected server response: (\d{3})/.exec(error?.message || "")?.[1]);
  return status
    ? providerHttpError({ ...ERROR_CONTEXT, status, body: "" })
    : asProviderError(error, ERROR_CONTEXT);
}

function firstWordOffsetMs(words) {
  if (!Array.isArray(words)) return null;
  const first = words.find((word) => word?.type !== "spacing" && typeof word?.start === "number");
  return first ? first.start * 1000 : null;
}

// Scribe v3 Live over WSS: xi-api-key header, base64 PCM inside JSON
// input_audio_chunk messages, and server-side VAD commits beside the client's own.
// Mirrors the Corti/Deepgram streaming classes the meeting pipeline drives.
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
    // Where on the server's clock the open partial began.
    this.partialStartMs = 0;
    this.isDisconnecting = false;
    this.preSessionBuffer = [];
    this.preSessionBufferSize = 0;
    this.bufferingAudio = false;
    this.sessionStartedAt = null;
    this.firstAudioAt = null;
    this.audioBytesSent = 0;
    // Audio the server has heard, the client's own silence included, and the points
    // where the caller's audio resumed behind that silence.
    this.streamMs = 0;
    this.streamAnchors = [];
    this.reanchorOnNextAudio = false;
    // Audio waiting for its tick, as the messages it will leave in.
    this.sendQueue = [];
    this.sendQueueBytes = 0;
    this.sendInterval = null;
    // The caller's audio a session that ended unasked had taken and never sent.
    this.unsentAudio = [];
    // Where the last commit sits in the stream, the server's or the client's own,
    // and how much quiet audio has come in a row since.
    this.committedMs = 0;
    this.quietBytes = 0;
    // When a commit of the client's own went out, until a committed transcript answers.
    this.commitSentAt = null;
    this.emptyCommits = 0;
    this.sampleRate = SAMPLE_RATE;
    this.keepAliveInterval = null;
    this.lastSendAt = 0;
    // Server message counts by type, logged when the session ends.
    this.messageCounts = {};
  }

  buildWebSocketUrl(options = {}) {
    const params = new URLSearchParams({
      model_id: options.model || REALTIME_MODEL,
      audio_format: `pcm_${this.sampleRate}`,
      commit_strategy: "vad",
      vad_silence_threshold_secs: String(VAD_SILENCE_SECS),
      include_timestamps: "true",
    });
    if (options.language && options.language !== "auto") {
      params.set("language_code", options.language);
    }
    const keyterms = sanitizeElevenLabsKeyterms(
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
    this.committedMs = 0;
    this.quietBytes = 0;
    this.commitSentAt = null;
    this.emptyCommits = 0;
    this.unsentAudio = [];
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
        this.rejectPending(providerError(C.TIMEOUT, ERROR_CONTEXT));
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
      const error = socketError(rawError);
      const wasActive = this.isConnected;
      debugLogger.error("ElevenLabs WebSocket error", { error: rawError.message });
      this.emitOpenPartial();
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
      this.rejectPending(providerError(C.UNAVAILABLE, ERROR_CONTEXT));
      this.emitOpenPartial();
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
    // Frames behind a reported end would make the open partial a final again.
    if (this.connectionLossNotified) return;
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
        this.startSending();
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

      case "partial_transcript": {
        const wasOpen = Boolean(this.currentPartial);
        this.currentPartial =
          message.text?.trim() === SCRIBE_SILENCE_MARKER ? "" : message.text || "";
        if (this.currentPartial) {
          this.emptyCommits = 0;
          if (!wasOpen) this.partialStartMs = this.streamMs;
        }
        this.onPartialTranscript?.(this.currentPartial);
        break;
      }

      case "committed_transcript":
      case "committed_transcript_with_timestamps":
        this.receiveCommit(message, type === "committed_transcript_with_timestamps");
        break;

      case "session_time_limit_exceeded":
        if (this.isDisconnecting) break;
        debugLogger.warn("ElevenLabs session time limit reached", { error: message.error });
        this.emitOpenPartial();
        // The session takes no more audio, so the meeting keeps it for the replacement,
        // and the close that follows is not a second loss.
        this.isConnected = false;
        this.connectionLossNotified = true;
        if (this.onSessionExpired) {
          this.onSessionExpired({ proactive: false });
        } else {
          this.notifyConnectionLost(serverError(type));
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
    const error = serverError(type);
    debugLogger.error("ElevenLabs streaming error", { type, detail });
    if (this.rejectPending(error)) {
      this.cleanup();
      return;
    }
    // Transient failures end with the server closing the socket, which reconnects.
    // A fatal one would fail every reconnect the same way, so it is reported as a
    // loss the meeting must not retry; the close that follows adds nothing.
    if (FATAL_ERROR_CODES.has(type)) {
      error.fatal = true;
      this.emitOpenPartial();
      this.notifyConnectionLost(error);
    }
  }

  // Word times count along the audio the server heard. A keep-alive adds only a
  // little of it for a long pause and a commit adds silence nobody captured, so
  // times after either are taken from where real audio resumed.
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

  msToBytes(ms) {
    return Math.round((this.sampleRate * ms) / 1000) * 2;
  }

  receiveCommit(message, timestamped) {
    const text = (message.text || "").trim();
    const spoken = Boolean(text) && text !== SCRIBE_SILENCE_MARKER;
    // Any committed transcript restarts the count towards the server's cut. Each
    // arrives as two frames: the plain one is the answer, and the one a stop counts.
    this.committedMs = Math.max(this.committedMs, this.streamMs);
    if (!timestamped) this.commitSentAt = null;
    if (spoken) this.emptyCommits = 0;
    else if (!timestamped) this.emptyCommits++;
    this.resolvePendingCommit();
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
    if (!spoken) this.onPartialTranscript?.("");
    // Without word times, place the segment at the last sample available when the
    // commit arrived. Waiting for its twin must not move the segment past later audio.
    const fallbackTimestamp = this.lastSampleTime();
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

  lastSampleTime() {
    const lastSampleMs = Math.max(0, this.streamMs - this.bytesToMs(2));
    return this.timeAtAudioOffset(lastSampleMs) ?? Date.now();
  }

  commitSegment(text, timestamp) {
    if (text && text !== SCRIBE_SILENCE_MARKER) {
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

  // Words the server will not commit any more exist only as the open partial, so it
  // becomes a final, behind a plain commit still waiting for its twin. It has no
  // word times, so it is placed where its first partial arrived.
  emitOpenPartial() {
    this.emitPendingPlainCommit();
    const text = this.currentPartial.trim();
    if (!text) return;
    this.currentPartial = "";
    this.commitSegment(text, this.timeAtAudioOffset(this.partialStartMs) ?? Date.now());
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
    this.streamMs += this.bytesToMs(pcmBuffer.length);
  }

  flushPreSessionBuffer() {
    this.bufferingAudio = false;
    if (this.preSessionBuffer.length === 0 || this.ws?.readyState !== WebSocket.OPEN) return;
    debugLogger.debug("ElevenLabs flushing pre-session buffer", {
      chunks: this.preSessionBuffer.length,
      bytes: this.preSessionBufferSize,
    });
    for (const chunk of this.preSessionBuffer) {
      this.queueAudio(chunk);
      this.audioBytesSent += chunk.length;
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
    this.audioBytesSent += pcmBuffer.length;
    const rms = computePcm16Rms(pcmBuffer);
    this.quietBytes = rms < SPEECH_FRAME_RMS ? this.quietBytes + pcmBuffer.length : 0;
    // Silence handed over faster than it can leave, such as a capture gap repaired in
    // one burst, would hold live audio behind it. Live audio never queues more than a
    // commit's wait and one message, and past a second of silence the server needs no
    // more of it, so the rest is left out and the next audio is anchored again.
    if (
      rms === 0 &&
      this.quietBytes > this.msToBytes(MAX_CHUNK_MS) &&
      this.sendQueueBytes > this.msToBytes(COMMIT_ACK_TIMEOUT_MS + MAX_CHUNK_MS)
    ) {
      this.reanchorOnNextAudio = true;
      return true;
    }
    if (
      capturedAt !== null &&
      capturedAt - this.timeAtAudioOffset(this.queueEndMs()) > CAPTURE_HOLE_MS
    ) {
      this.reanchorOnNextAudio = true;
    }
    const reanchored = this.reanchorOnNextAudio;
    if (reanchored) {
      this.reanchorOnNextAudio = false;
      this.streamAnchors.push({ offsetMs: this.queueEndMs(), at: capturedAt ?? Date.now() });
    }
    this.queueAudio(Buffer.from(pcmBuffer), reanchored);
    this.commitInPause();
    return true;
  }

  // Where audio handed over now lands on the server's clock: behind what was sent
  // and what is still queued.
  queueEndMs() {
    return this.streamMs + this.bytesToMs(this.sendQueueBytes);
  }

  // Audio joins the queue's last message until that one holds a second. Audio behind
  // a re-anchor starts its own, so a message is one unbroken stretch of the caller's
  // audio and carries the time its first sample was captured.
  queueAudio(pcmBuffer, reanchored = false) {
    const maxBytes = this.msToBytes(MAX_CHUNK_MS);
    let offset = 0;
    while (offset < pcmBuffer.length) {
      let message = this.sendQueue.at(-1);
      if (!message || message.commit || message.bytes === maxBytes || (reanchored && !offset)) {
        const capturedAt = this.timeAtAudioOffset(
          this.streamMs + this.bytesToMs(this.sendQueueBytes + offset)
        );
        message = { chunks: [], bytes: 0, commit: false, capturedAt };
        this.sendQueue.push(message);
      }
      const chunk = pcmBuffer.subarray(offset, offset + maxBytes - message.bytes);
      message.chunks.push(chunk);
      message.bytes += chunk.length;
      offset += chunk.length;
    }
    this.sendQueueBytes += pcmBuffer.length;
  }

  // A commit is a message of its own, queued behind the audio so far.
  queueCommit() {
    const silence = Buffer.alloc(this.msToBytes(COMMIT_SILENCE_MS));
    this.sendQueue.push({ chunks: [silence], bytes: silence.length, commit: true });
    this.sendQueueBytes += silence.length;
    this.reanchorOnNextAudio = true;
    this.committedMs = this.queueEndMs();
  }

  // Frames under the speech level are a pause. Silence is one too, so a silent stream
  // is committed every 20 s and speech never starts with the server's count nearly spent.
  commitInPause() {
    if (
      this.quietBytes >= this.msToBytes(COMMIT_PAUSE_MS) &&
      this.queueEndMs() - this.committedMs >= COMMIT_AFTER_MS
    ) {
      this.queueCommit();
    }
  }

  // One message a tick. What follows a commit waits for its answer: audio sent in
  // the same burst went into the segment being committed and was not transcribed.
  sendQueued() {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.isConnected) return;
    if (this.sendQueue.length === 0 || this.isAwaitingCommitAck()) return;
    this.sendNext();
  }

  sendNext() {
    const { chunks, bytes, commit } = this.sendQueue.shift();
    this.sendQueueBytes -= bytes;
    this.sendChunk(Buffer.concat(chunks, bytes), commit);
    if (commit) {
      this.commitSentAt = Date.now();
      debugLogger.debug("ElevenLabs commit sent");
    }
  }

  isAwaitingCommitAck(timeoutMs = COMMIT_ACK_TIMEOUT_MS) {
    return this.commitSentAt !== null && Date.now() - this.commitSentAt < timeoutMs;
  }

  // Empties the queue into the caller's audio that never left. Commit silence is the
  // client's own.
  drainUnsentAudio() {
    for (const { chunks, bytes, commit, capturedAt } of this.sendQueue) {
      if (!commit) this.unsentAudio.push({ buffer: Buffer.concat(chunks, bytes), capturedAt });
    }
    this.sendQueue = [];
    this.sendQueueBytes = 0;
  }

  // After an unasked end: what this session took and never sent, handed over once
  // for the session that replaces it.
  takeUnsentAudio() {
    this.drainUnsentAudio();
    const unsent = this.unsentAudio;
    this.unsentAudio = [];
    return unsent;
  }

  startSending() {
    this.stopSending();
    this.sendInterval = setInterval(() => this.sendQueued(), SEND_INTERVAL_MS);
  }

  stopSending() {
    if (this.sendInterval) {
      clearInterval(this.sendInterval);
      this.sendInterval = null;
    }
  }

  // Commits everything handed over and reads on until the server has answered it.
  // The server applies a commit in audio order, so every worded transcript on the
  // way is a final.
  async finalize() {
    // Behind a backlog an answer takes longer, so each wait allows for what is flushed.
    const timeoutMs =
      COMMIT_ACK_TIMEOUT_MS +
      (this.bytesToMs(this.sendQueueBytes) / 1000) * BACKLOG_TIMEOUT_MS_PER_SECOND;
    // What is queued leaves back-to-back from here, but still not right behind a commit.
    this.stopSending();
    while (this.isConnected && (this.sendQueue.length > 0 || this.isAwaitingCommitAck(timeoutMs))) {
      if (this.isAwaitingCommitAck(timeoutMs)) {
        await this.waitForCommit(this.commitSentAt + timeoutMs - Date.now());
      } else {
        this.sendNext();
      }
    }
    if (!this.isConnected) return;
    for (let sent = 0; sent < STOP_COMMITS; sent++) {
      this.queueCommit();
      this.sendNext();
    }
    this.emptyCommits = 0;
    const deadline = Date.now() + timeoutMs;
    while (this.isConnected && this.emptyCommits < STOP_COMMITS - 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await this.waitForCommit(remaining))) return;
    }
  }

  startKeepAlive() {
    this.stopKeepAlive();
    this.lastSendAt = Date.now();
    this.keepAliveInterval = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN || !this.isConnected) return;
      // Audio waiting for its tick is no gap.
      if (this.sendQueue.length > 0 || Date.now() - this.lastSendAt < KEEPALIVE_IDLE_MS) return;
      // 100 ms every 5 s never gives the VAD its silence, so the first keep-alive of
      // a gap commits the sentence before it instead.
      if (!this.reanchorOnNextAudio && this.streamMs > this.committedMs) {
        this.queueCommit();
        return;
      }
      const silence = Buffer.alloc(this.msToBytes(KEEPALIVE_SILENCE_MS));
      try {
        this.sendChunk(silence);
        this.reanchorOnNextAudio = true;
      } catch (err) {
        debugLogger.debug("ElevenLabs keep-alive failed", { error: err.message });
      }
    }, KEEPALIVE_POLL_MS);
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

  // Resolves true on the next commit, received or emitted, false on timeout or cleanup.
  waitForCommit(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCommit = null;
        resolve(false);
      }, timeoutMs);
      this.pendingCommit = { resolve, timer };
    });
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
      if (this.currentPartial || this.audioBytesSent > 0) await this.finalize();
      else if (this.pendingPlainCommit) await this.waitForCommit(PLAIN_COMMIT_GRACE_MS);
      this.emitOpenPartial();
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
    this.stopSending();
    this.drainUnsentAudio();
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
}

module.exports = ElevenLabsStreaming;
