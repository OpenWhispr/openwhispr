const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const XAI_STT_STREAMING_URL = "wss://api.x.ai/v1/stt";
const SAMPLE_RATE = 16000;
const WEBSOCKET_TIMEOUT_MS = 30000;
const TERMINATION_TIMEOUT_MS = 5000;
const MAX_KEYTERMS = 100;
const MAX_KEYTERM_LENGTH = 50;
const OVERLAP_TOLERANCE_S = 0.05;
const RECENT_SEGMENTS_COMPARED = 3;
const MIN_CUMULATIVE_OVERLAP_WORDS = 3;

// Case and punctuation differ between a chunk final and its restatement.
const wordKey = (word) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// xAI's streaming STT: Bearer key on the upgrade, configuration in the query
// string, raw PCM frames after `transcript.created`. The finality fields are
// Deepgram's (`is_final` chunk finals, `speech_final` utterance end), so each
// chunk final becomes one segment, as in DeepgramStreaming. Note recording only.
class XaiStreaming {
  constructor(baseUrl = XAI_STT_STREAMING_URL) {
    this.baseUrl = baseUrl;
    this.ws = null;
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
    this.completedSegments = [];
    this.committedAudioEnd = null;
    this.pendingDone = null;
    this.isDisconnecting = false;
    this.sessionReady = false;
    this.preReadyBuffer = [];
    this.preReadyBufferSize = 0;
    this.sessionStartedAt = null;
    this.audioBytesSent = 0;
    this.sampleRate = SAMPLE_RATE;
  }

  async buildWebSocketUrl(options) {
    const params = new URLSearchParams({
      sample_rate: String(this.sampleRate),
      encoding: "pcm",
      interim_results: "true",
    });
    // Same language gate as the batch proxy: an unsupported code is left out
    // rather than sent, so the server falls back to its own detection.
    const { XAI_STT_LANGUAGES } = await import("./transcriptionRoute.ts");
    if (
      options.language &&
      options.language !== "auto" &&
      XAI_STT_LANGUAGES.has(options.language)
    ) {
      params.set("language", options.language);
    }
    const keyterms = (options.keyterms || [])
      .map((term) => (typeof term === "string" ? term.trim() : ""))
      .filter((term) => term && term.length <= MAX_KEYTERM_LENGTH)
      .slice(0, MAX_KEYTERMS);
    for (const term of keyterms) params.append("keyterm", term);
    return `${this.baseUrl}?${params}`;
  }

  async connect(options = {}) {
    const apiKey = options.apiKey || options.token;
    if (!apiKey) throw new Error("xAI streaming requires an API key");

    if (this.isConnected) {
      debugLogger.debug("xAI streaming already connected");
      return;
    }

    this.accumulatedText = "";
    this.completedSegments = [];
    this.committedAudioEnd = null;
    this.sessionReady = false;
    this.connectionLossNotified = false;
    this.preReadyBuffer = [];
    this.preReadyBufferSize = 0;
    this.audioBytesSent = 0;
    this.sampleRate = options.sampleRate || SAMPLE_RATE;

    const url = await this.buildWebSocketUrl(options);
    debugLogger.debug("xAI streaming connecting", {
      stream: options.streamLabel,
      sampleRate: this.sampleRate,
      language: options.language,
    });

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("xAI WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      this.attachSocketHandlers(this.ws);
    });
  }

  attachSocketHandlers(ws) {
    ws.on("message", (data) => {
      this.handleMessage(data);
    });

    // A rejected upgrade (bad key, quota) arrives here as
    // "Unexpected server response: <status>".
    ws.on("error", (error) => {
      const wasActive = this.isConnected;
      debugLogger.error("xAI WebSocket error", { error: error.message });
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

    ws.on("close", (code, reason) => {
      const wasActive = this.isConnected;
      debugLogger.debug("xAI WebSocket closed", {
        code,
        reason: reason?.toString(),
        wasActive,
      });
      if (this.pendingReject) {
        this.pendingReject(new Error(`xAI WebSocket closed before ready (code: ${code})`));
        this.pendingReject = null;
        this.pendingResolve = null;
      }
      this.resolvePendingDone();
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
      debugLogger.error("xAI message parse error", { error: err.message });
      return;
    }

    switch (message.type) {
      case "transcript.created":
        this.isConnected = true;
        this.sessionReady = true;
        this.sessionStartedAt = Date.now();
        clearTimeout(this.connectionTimeout);
        this.flushPreReadyBuffer();
        debugLogger.debug("xAI session started");
        if (this.pendingResolve) {
          this.pendingResolve();
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        break;

      case "transcript.partial": {
        const text = message.text;
        if (!text) break;
        if (message.is_final) {
          const trimmed = text.trim();
          if (!trimmed) break;
          const fresh = this.takeUncommittedText(trimmed, message);
          debugLogger.debug("xAI final transcript", {
            speechFinal: !!message.speech_final,
            start: message.start,
            duration: message.duration,
            text: trimmed.slice(0, 80),
            kept: fresh.slice(0, 80),
          });
          if (!fresh) break;
          this.completedSegments.push(fresh);
          this.accumulatedText = this.completedSegments.join(" ");
          const startedAt =
            this.sessionStartedAt != null && typeof message.start === "number"
              ? this.sessionStartedAt + message.start * 1000
              : Date.now();
          this.onFinalTranscript?.(this.accumulatedText, startedAt);
        } else {
          this.onPartialTranscript?.(text);
        }
        break;
      }

      case "transcript.done":
        // Logged rather than appended: whether it repeats the chunk finals or
        // only carries the tail is not documented, so finals come from
        // `finalize` (sent before audio.done) instead.
        debugLogger.debug("xAI transcript done", {
          doneLength: typeof message.text === "string" ? message.text.length : null,
          accumulatedLength: this.accumulatedText.length,
        });
        this.resolvePendingDone();
        break;

      case "error": {
        const detail = message.message || message.error?.message || message.error || "xAI error";
        debugLogger.error("xAI streaming error", { error: detail });
        this.onError?.(new Error(String(detail)));
        break;
      }

      default:
        debugLogger.debug("xAI unknown message type", { type: message.type });
    }
  }

  // xAI can send the same words as final more than once: `finalize` locks the
  // utterance, then the utterance-final event after `audio.done` repeats it.
  // A final that starts on audio past what is already committed is new speech
  // and kept as is, so a phrase genuinely said twice survives. One overlapping
  // committed audio (or without timing) is checked against the recent text:
  // a repeat is dropped, and a cumulative one keeps only its new words.
  takeUncommittedText(text, message) {
    const start = typeof message.start === "number" ? message.start : null;
    const duration = typeof message.duration === "number" ? message.duration : null;
    const overlapsCommitted =
      start === null || this.committedAudioEnd === null
        ? this.completedSegments.length > 0
        : start < this.committedAudioEnd - OVERLAP_TOLERANCE_S;
    if (start !== null && duration !== null) {
      this.committedAudioEnd = Math.max(this.committedAudioEnd ?? 0, start + duration);
    }
    if (!overlapsCommitted) return text;

    const words = text.split(/\s+/).filter(Boolean);
    const keys = words.map(wordKey);
    const committedKeys = this.completedSegments
      .slice(-RECENT_SEGMENTS_COMPARED)
      .join(" ")
      .split(/\s+/)
      .filter(Boolean)
      .map(wordKey);

    const tail = committedKeys.slice(-keys.length);
    if (keys.length <= committedKeys.length && tail.join(" ") === keys.join(" ")) return "";

    // Cumulative: the final restates the committed words, then continues.
    const minOverlap = Math.min(MIN_CUMULATIVE_OVERLAP_WORDS, committedKeys.length);
    for (
      let overlap = Math.min(committedKeys.length, keys.length - 1);
      overlap >= minOverlap && overlap > 0;
      overlap--
    ) {
      if (committedKeys.slice(-overlap).join(" ") === keys.slice(0, overlap).join(" ")) {
        return words.slice(overlap).join(" ");
      }
    }
    return text;
  }

  flushPreReadyBuffer() {
    if (this.preReadyBuffer.length === 0) return;
    debugLogger.debug("xAI flushing pre-ready buffer", {
      chunks: this.preReadyBuffer.length,
      bytes: this.preReadyBufferSize,
    });
    for (const frame of this.preReadyBuffer) {
      this.ws.send(frame);
      this.audioBytesSent += frame.length;
    }
    this.preReadyBuffer = [];
    this.preReadyBufferSize = 0;
  }

  sendAudio(pcmBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (!this.sessionReady) {
      // Audio before `transcript.created` is dropped server-side; hold ~3s.
      if (this.preReadyBufferSize < 3 * this.sampleRate * 2) {
        const copy = Buffer.from(pcmBuffer);
        this.preReadyBuffer.push(copy);
        this.preReadyBufferSize += copy.length;
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
    this.ws.send(JSON.stringify({ type: "finalize" }));
    return true;
  }

  resolvePendingDone() {
    if (!this.pendingDone) return;
    clearTimeout(this.pendingDone.timer);
    this.pendingDone.resolve();
    this.pendingDone = null;
  }

  waitForDone() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDone = null;
        resolve();
      }, TERMINATION_TIMEOUT_MS);
      this.pendingDone = { resolve, timer };
    });
  }

  async disconnect(closeStream = true) {
    if (!this.ws) return { text: this.accumulatedText };

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN && this.sessionReady) {
      // Lock the in-progress utterance as a chunk final, then end the audio and
      // wait for `transcript.done`, after which xAI closes the socket.
      this.ws.send(JSON.stringify({ type: "finalize" }));
      this.ws.send(JSON.stringify({ type: "audio.done" }));
      await this.waitForDone();
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
    this.preReadyBuffer = [];
    this.preReadyBufferSize = 0;

    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch (err) {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.sessionReady = false;
    this.resolvePendingDone();
  }

  getStatus() {
    return { isConnected: this.isConnected };
  }
}

module.exports = XaiStreaming;
module.exports.XAI_STT_STREAMING_URL = XAI_STT_STREAMING_URL;
