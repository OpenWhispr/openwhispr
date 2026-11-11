const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const { i18nMain } = require("./i18nMain");

const DEFAULT_MODEL = "voxtral-mini-transcribe-realtime-3";
const CONNECT_TIMEOUT_MS = 15000;
const DRAIN_TIMEOUT_MS = 10000;

// Mistral has its own session/audio protocol; it is not OpenAI Realtime.
// Deltas are append-only, final text. No speaker labels or exact word times
// are requested: meeting mic/system attribution remains owned by OpenWhispr.
class MistralRealtimeStreaming {
  constructor(createSocket = (url, options) => new WebSocket(url, options)) {
    this.createSocket = createSocket;
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.isDisconnecting = false;
    this.completedSegments = [];
    this.text = "";
    this.emittedLength = 0;
    this.audioBytesSent = 0;
    this.timestampIsSpeechStart = false;
    this.connectionLossNotified = false;
    this.streamLabel = null;
  }

  async connect(options = {}) {
    if (!options.apiKey)
      throw new Error(i18nMain.t("hooks.audioRecording.errorDescriptions.providerKeyMissing"));
    if (this.ws || this.disconnectPromise)
      throw new Error(i18nMain.t("streaming.errors.mistral.sessionAlreadyOpen"));
    this.streamLabel = options.streamLabel ?? null;
    this.model = options.model || DEFAULT_MODEL;
    this.isConnecting = true;
    this.isDisconnecting = false;
    this.connectionLossNotified = false;
    this.completedSegments = [];
    this.text = "";
    this.emittedLength = 0;
    this.audioBytesSent = 0;
    this.sessionStartedAt = null;
    this.segmentStartedAt = null;
    this.done = false;
    this.sampleRate = options.sampleRate || 24000;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
    const language = options.language?.trim().toLowerCase().split(/[-_]/)[0];
    this.session = {
      audio_format: { encoding: "pcm_s16le", sample_rate: this.sampleRate },
      target_streaming_delay_ms: 480,
      ...(language && language !== "auto" ? { language } : {}),
    };
    const url = new URL("wss://api.mistral.ai/v1/audio/transcriptions/realtime");
    url.searchParams.set("model", this.model);
    debugLogger.debug("Mistral realtime connecting", this._logContext({ model: this.model }));
    try {
      this.ws = this.createSocket(url.toString(), {
        headers: { Authorization: `Bearer ${options.apiKey}` },
      });
    } catch {
      this.isConnecting = false;
      debugLogger.warn("Mistral realtime socket setup failed", this._logContext());
      throw new Error(i18nMain.t("providerErrors.unreachable", { provider: "Mistral" }));
    }
    const socket = this.ws;
    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.connectionTimeout = setTimeout(
        () => this.fail(new Error(i18nMain.t("providerErrors.timeout", { provider: "Mistral" }))),
        options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
      );
      socket.on("message", (data) => {
        if (socket === this.ws) this.handleMessage(data);
      });
      socket.on("error", (error) => {
        if (socket !== this.ws) return;
        // Never forward raw transport errors: gateways may echo credentials.
        const status = error.message?.match(/\b(401|403|429)\b/)?.[1];
        this.fail(new Error(this.errorMessage(status)));
      });
      socket.on("close", () => {
        if (socket !== this.ws) return;
        if (this.done || this.isDisconnecting) {
          if (!this.done) {
            debugLogger.warn("Mistral realtime closed before finalization", this._logContext());
            this.onError?.(
              new Error(i18nMain.t("streaming.errors.mistral.incompleteFinalization"))
            );
          }
          this.flushText(true);
          this.finishDrain?.();
          this.cleanup();
        } else {
          this.fail(new Error(i18nMain.t("streaming.errors.mistral.connectionClosed")));
        }
      });
    });
  }

  errorMessage(code) {
    if (/403|forbidden|permission/i.test(String(code))) {
      return i18nMain.t("providerErrors.accessDenied", { provider: "Mistral" });
    }
    if (/401|unauthor|auth|api.?key/i.test(String(code))) {
      return i18nMain.t("providerErrors.authFailed", { provider: "Mistral" });
    }
    if (/quota|credit/i.test(String(code))) {
      return i18nMain.t("providerErrors.quotaExhausted", { provider: "Mistral" });
    }
    if (/429|rate|capacity/i.test(String(code))) {
      return i18nMain.t("providerErrors.rateLimited", { provider: "Mistral" });
    }
    return i18nMain.t("providerErrors.noResponse", { provider: "Mistral" });
  }

  _logContext(extra) {
    if (this.streamLabel == null) return extra;
    return { stream: this.streamLabel, ...extra };
  }

  handleMessage(data) {
    let event;
    try {
      event = JSON.parse(data.toString());
      if (!event || typeof event.type !== "string") throw new Error("Invalid event");
    } catch {
      this.fail(new Error(i18nMain.t("streaming.errors.mistral.invalidMessage")));
      return;
    }
    switch (event.type) {
      case "session.created":
        try {
          this.ws.send(JSON.stringify({ type: "session.update", session: this.session }));
        } catch {
          this.fail(new Error(i18nMain.t("providerErrors.unreachable", { provider: "Mistral" })));
        }
        break;
      case "session.updated":
        if (!this.pendingResolve) break;
        if (
          event.session?.audio_format &&
          (event.session.audio_format.encoding !== "pcm_s16le" ||
            event.session.audio_format.sample_rate !== this.sampleRate)
        ) {
          this.fail(new Error(i18nMain.t("streaming.errors.mistral.audioFormatRejected")));
          break;
        }
        clearTimeout(this.connectionTimeout);
        this.isConnecting = false;
        this.isConnected = true;
        debugLogger.debug("Mistral realtime connected", this._logContext());
        this.pendingResolve();
        this.pendingResolve = null;
        this.pendingReject = null;
        break;
      case "transcription.text.delta":
        if (this.done || typeof event.text !== "string") break;
        this.segmentStartedAt ??= Date.now();
        this.text += event.text;
        this.flushText(false);
        break;
      case "transcription.done":
        if (this.done) break;
        this.done = true;
        // done repeats the full session. Only its still-unemitted suffix may
        // become a new meeting segment, including words delivered after stop.
        if (typeof event.text === "string") {
          const emitted = this.text.slice(0, this.emittedLength);
          if (event.text.startsWith(emitted)) this.text = event.text;
        }
        this.flushText(true);
        debugLogger.debug(
          "Mistral realtime finalized",
          this._logContext({
            audioBytesSent: this.audioBytesSent,
            segments: this.completedSegments.length,
          })
        );
        this.finishDrain?.();
        if (!this.isDisconnecting) {
          this.fail(new Error(i18nMain.t("streaming.errors.mistral.connectionClosed")));
        }
        break;
      case "error":
        this.fail(
          new Error(this.errorMessage(event.error?.code || event.error?.message || event.code))
        );
        break;
    }
  }

  flushText(force) {
    const remaining = this.text.slice(this.emittedLength);
    // Commit complete sentences as they arrive, or long phrases at a word
    // boundary. Keep exact whitespace in `text`; meeting segments are trimmed.
    let length = force ? remaining.length : 0;
    if (!force) {
      const boundaries = [...remaining.matchAll(/[.!?](?:\s|$)|[。！？]/g)];
      const last = boundaries.at(-1);
      if (last) length = last.index + last[0].length;
      else if (remaining.length >= 180) {
        const wordBoundary = remaining.lastIndexOf(" ");
        length = wordBoundary > 0 ? wordBoundary : remaining.length;
      }
    }
    if (length > 0) {
      const segment = remaining.slice(0, length).trim();
      this.emittedLength += length;
      if (segment) {
        this.completedSegments.push(segment);
        this.onFinalTranscript?.(
          this.text.slice(0, this.emittedLength).trim(),
          this.segmentStartedAt || Date.now()
        );
      }
      this.segmentStartedAt = null;
    }
    this.onPartialTranscript?.(this.text.slice(this.emittedLength).trim());
  }

  sendAudio(pcmBuffer) {
    if (!this.isConnected || this.isDisconnecting || this.ws?.readyState !== WebSocket.OPEN)
      return false;
    const buffer = Buffer.from(pcmBuffer);
    if (!buffer.length) return true;
    try {
      this.ws.send(
        JSON.stringify({ type: "input_audio.append", audio: buffer.toString("base64") })
      );
      this.sessionStartedAt ??= Date.now();
      this.audioBytesSent += buffer.length;
      return true;
    } catch {
      this.fail(new Error(i18nMain.t("providerErrors.unreachable", { provider: "Mistral" })));
      return false;
    }
  }

  fail(error) {
    const connecting = this.isConnecting;
    const active = this.isConnected;
    const stopping = this.isDisconnecting;
    debugLogger.warn(
      "Mistral realtime failed",
      this._logContext({ error: error.message, connecting, disconnecting: stopping })
    );
    this.flushText(true);
    this.pendingReject?.(error);
    this.pendingReject = null;
    this.pendingResolve = null;
    this.finishDrain?.();
    this.cleanup();
    if (connecting) return;
    if (stopping) this.onError?.(error);
    else if (active && !this.connectionLossNotified) {
      this.connectionLossNotified = true;
      if (this.onConnectionLost) this.onConnectionLost(error);
      else this.onError?.(error);
    }
  }

  getFullTranscript() {
    return this.text.trim();
  }

  async disconnect({ commit = true } = {}) {
    if (this.disconnectPromise) {
      if (!commit) this.cleanup();
      return this.disconnectPromise;
    }
    this.disconnectPromise = this.drain(commit);
    try {
      return await this.disconnectPromise;
    } finally {
      this.disconnectPromise = null;
    }
  }

  async drain(commit) {
    this.isDisconnecting = true;
    if (commit && this.isConnected && !this.done && this.ws?.readyState === WebSocket.OPEN) {
      debugLogger.debug(
        "Mistral realtime finalizing",
        this._logContext({ audioBytesSent: this.audioBytesSent })
      );
      let timer;
      const drained = new Promise((resolve) => {
        this.finishDrain = resolve;
        timer = setTimeout(() => {
          debugLogger.warn("Mistral realtime finalization timed out", this._logContext());
          this.onError?.(new Error(i18nMain.t("streaming.errors.mistral.incompleteFinalization")));
          resolve();
        }, this.drainTimeoutMs);
      });
      try {
        this.ws.send(JSON.stringify({ type: "input_audio.end" }));
        await drained;
      } catch {
        debugLogger.warn("Mistral realtime finalization send failed", this._logContext());
        this.onError?.(new Error(i18nMain.t("streaming.errors.mistral.incompleteFinalization")));
      } finally {
        clearTimeout(timer);
        this.finishDrain = null;
      }
    }
    this.flushText(true);
    const result = { text: this.getFullTranscript() };
    this.cleanup();
    this.isDisconnecting = false;
    debugLogger.debug(
      "Mistral realtime disconnected",
      this._logContext({ commit, finalized: this.done })
    );
    return result;
  }

  cleanup() {
    this.pendingReject?.(new Error(i18nMain.t("notes.upload.batchCancelled")));
    this.pendingReject = null;
    this.pendingResolve = null;
    this.finishDrain?.();
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.isConnected = false;
    this.isConnecting = false;
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      // Keep an error listener while terminating a connecting WebSocket.
      socket.removeAllListeners("message");
      socket.removeAllListeners("close");
      socket.removeAllListeners("error");
      socket.on("error", () => {});
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    }
  }
}

module.exports = MistralRealtimeStreaming;
