const WebSocket = require("ws");
const { sarvamLanguage, sarvamKeyterms } = require("../utils/sarvam");
const { providerError, PROVIDER_ERROR_CODES } = require("./providerHttpErrors");
const { downsample24kTo16k } = require("../utils/audioUtils");

class SarvamRealtimeStreaming {
  constructor(WebSocketImpl = WebSocket) {
    this.WebSocketImpl = WebSocketImpl;
    this.isConnected = false;
    this.audioBytesSent = 0;
    this.utterances = new Map();
  }

  async connect({ apiKey, model, language, keyterms, returnTimestamps = false }) {
    if (!apiKey) {
      throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
        provider: "Sarvam AI",
        surface: "transcription",
      });
    }
    if (model !== "saaras:v4" && model !== "saaras:v3") throw new Error("Unsupported Sarvam model");
    this.model = model;
    const url = new URL("wss://api.sarvam.ai/speech-to-text-realtime/ws");
    const hint = sarvamLanguage(language);
    url.search = new URLSearchParams({
      language_code: hint === "od-IN" ? "or-IN" : hint || "auto",
      model: model === "saaras:v3" ? "saaras:v3-realtime" : model,
      encoding: "linear16",
      sample_rate: "16000",
      mode: "transcribe",
      stream_type: "fast",
    }).toString();
    if (returnTimestamps) url.searchParams.set("return_timestamps", "true");
    const terms = model === "saaras:v4" ? sarvamKeyterms(keyterms) : [];
    if (terms.length) url.searchParams.set("keyterms", JSON.stringify(terms));

    const ws = new this.WebSocketImpl(url, {
      headers: { "Api-Subscription-Key": apiKey },
      handshakeTimeout: 10000,
    });
    this.ws = ws;
    this.ready = Promise.withResolvers();
    this.timer = setTimeout(() => this.fail(new Error("Sarvam connection timed out")), 10000);
    ws.on("message", (data) => {
      if (this.closed) return;
      try {
        this.handleMessage(JSON.parse(data));
      } catch (error) {
        this.fail(error);
      }
    });
    ws.on("error", (error) => this.fail(error));
    ws.on("close", (code) => {
      if (!this.closed)
        this.fail(new Error(`Sarvam connection closed before completion (${code})`));
    });
    return this.ready.promise;
  }

  handleMessage(message) {
    switch (message.event) {
      case "session.begin":
        clearTimeout(this.timer);
        this.isConnected = true;
        this.ready.resolve();
        break;
      case "transcript.partial":
        if (typeof message.text === "string") this.onPartialTranscript?.(message.text);
        break;
      case "transcript.final":
        if (!Number.isInteger(message.utterance_idx) || typeof message.text !== "string") {
          throw new Error("Invalid Sarvam final transcript");
        }
        if (this.utterances.has(message.utterance_idx)) break;
        this.utterances.set(message.utterance_idx, message.text.trim());
        this.emitFinal(message.text.trim(), message.start_s);
        break;
      case "session.end":
        if (!this.final) throw new Error("Sarvam ended the recording before stop");
        this.result = {
          text: this.fullText(),
          model: this.model,
          audioBytesSent: this.audioBytesSent,
        };
        this.final.resolve(this.result);
        this.close();
        break;
      case "error":
        if (message.is_fatal !== false)
          throw new Error(message.message || "Sarvam transcription failed");
        break;
    }
  }

  fullText() {
    return [...this.utterances]
      .sort(([a], [b]) => a - b)
      .map(([, text]) => text)
      .filter(Boolean)
      .join(" ");
  }

  emitFinal() {
    this.onFinalTranscript?.(this.fullText());
  }

  sendAudio(pcm) {
    if (!this.isConnected || this.final) return false;
    if (this.ws.bufferedAmount > 2 * 1024 * 1024) {
      this.fail(new Error("Sarvam audio upload could not keep up with the recording"));
      return false;
    }
    this.ws.send(JSON.stringify({ event: "audio_input", audio: pcm.toString("base64") }));
    this.audioBytesSent += pcm.length;
    return true;
  }

  async finalize() {
    if (this.failure) throw this.failure;
    if (this.final) return this.final.promise;
    if (!this.isConnected) throw new Error("Sarvam connection is not ready");
    this.final = Promise.withResolvers();
    this.timer = setTimeout(() => this.fail(new Error("Sarvam final transcript timed out")), 15000);
    // 'end' drains the current utterance; each earlier final covers just one utterance.
    this.ws.send(JSON.stringify({ event: "end" }));
    return this.final.promise;
  }

  fail(error) {
    if (this.closed) return;
    this.failure = error;
    const wasConnected = this.isConnected;
    this.ready?.reject(error);
    this.final?.reject(error);
    this.close();
    if (wasConnected) {
      if (!this.final && this.onConnectionLost) this.onConnectionLost(error);
      else this.onError?.(error);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.isConnected = false;
    clearTimeout(this.timer);
    if (this.ws?.readyState === WebSocket.CONNECTING) this.ws.terminate();
    else this.ws?.close();
    this.onClose?.();
  }

  async disconnect() {
    const error = new Error("Sarvam recording cancelled");
    this.ready?.reject(error);
    this.final?.reject(error);
    this.close();
    return this.result || { text: "", model: this.model, audioBytesSent: this.audioBytesSent };
  }
}

// Meetings provide independent 24 kHz microphone and system tracks and consume
// individual timestamped segments. Dictation already supplies 16 kHz audio.
class SarvamMeetingStreaming extends SarvamRealtimeStreaming {
  constructor(WebSocketImpl) {
    super(WebSocketImpl);
    this.completedSegments = [];
    this.remainder = Buffer.alloc(0);
    this.sessionStartedAt = null;
  }

  connect(options) {
    return super.connect({ ...options, returnTimestamps: true });
  }

  sendAudio(buffer) {
    if (!this.isConnected || this.final) return false;
    if (this.sessionStartedAt === null) this.sessionStartedAt = Date.now();
    const pcm = this.remainder.length ? Buffer.concat([this.remainder, buffer]) : buffer;
    // Three 24 kHz samples produce two 16 kHz samples. Preserve phase across IPC frames.
    const usable = pcm.length - (pcm.length % 6);
    this.remainder = pcm.subarray(usable);
    return usable === 0 || super.sendAudio(downsample24kTo16k(pcm.subarray(0, usable)));
  }

  emitFinal(text, startSeconds) {
    if (!text) return;
    this.completedSegments.push(text);
    const timestamp =
      this.sessionStartedAt !== null && Number.isFinite(startSeconds)
        ? this.sessionStartedAt + Math.round(startSeconds * 1000)
        : Date.now();
    this.onFinalTranscript?.(text, timestamp);
  }

  async disconnect({ commit = true } = {}) {
    if (commit && this.isConnected && this.audioBytesSent) return this.finalize();
    return super.disconnect();
  }
}

module.exports = { SarvamRealtimeStreaming, SarvamMeetingStreaming };
