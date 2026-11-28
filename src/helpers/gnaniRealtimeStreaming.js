const WebSocket = require("ws");
const { downsample24kTo16k, pcm16ToWav } = require("../utils/audioUtils");
const { transcribeGnaniRecording } = require("./gnaniTranscription");
const { resolveGnaniConfig, asciiJson } = require("./gnaniConfig");
const { providerError, providerHttpError, PROVIDER_ERROR_CODES } = require("./providerHttpErrors");

const URL = "wss://api.vachana.ai/stt/v3/stream";
const FRAME_BYTES = 1024;
const FRAME_MS = 32;
const MAX_FRAMES = Math.ceil(30_000 / FRAME_MS);
const DRAIN_MS = 6000;
const QUIET_MS = 900;
const ROTATE_MS = 14 * 60_000 + 30_000;

function hasSignal(frame) {
  // A commit has no acknowledgement on silent audio. If non-silent PCM remains
  // unaccounted for after the drain, let dictation recover the original recording.
  for (let offset = 0; offset < frame.length; offset += 2) {
    if (Math.abs(frame.readInt16LE(offset)) > 220) return true;
  }
  return false;
}

function protocolError(message) {
  return new Error(`GnaniAI: ${message}`);
}

class GnaniRealtimeStreaming {
  constructor(WebSocketImpl = WebSocket) {
    this.WebSocketImpl = WebSocketImpl;
    this.inputFrameBytes = FRAME_BYTES;
    this.queue = [];
    this.retained = [];
    this.carry = Buffer.alloc(0);
    this.nextFrame = 0;
    this.audioBytesSent = 0;
    this.isConnected = false;
    this.completedSegments = [];
    this.retries = 0;
  }

  async connect({ apiKey, model, language, keyterms }) {
    if (!apiKey)
      throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
        provider: "GnaniAI",
        surface: "transcription",
      });
    const config = resolveGnaniConfig({ model, language, keyterms });
    this.model = config.model;
    this.language = config.languageCode === "indic-auto" ? undefined : config.languageCode;
    this.headers = {
      "x-api-key-id": apiKey,
      model: config.model,
      language_code: config.languageCode,
      format: config.format,
      "x-sample-rate": "16000",
      // Bound the unacknowledged audio that a reconnect might need to replay.
      "x-max-speech-s": "20",
      ...(config.keyterms?.length && { keyterms: asciiJson(config.keyterms) }),
    };
    this.ready = Promise.withResolvers();
    this.openSocket();
    return this.ready.promise;
  }

  openSocket() {
    const ws = new this.WebSocketImpl(URL, { headers: this.headers, handshakeTimeout: 8000 });
    this.ws = ws;
    this.serverReady = false;
    this.pendingSpeech = new Map();
    this.processingCount = 0;
    this.seen = new Set();
    this.finalByIndex = new Map();
    this.expectedSegment = 1;
    this.nextSendAt = 0;
    this.sessionFirstFrame = null;
    this.handshakeTimer = setTimeout(
      () => this.connectionFailed(protocolError("connection timed out")),
      9000
    );
    ws.on("message", (wire) => {
      if (this.ws !== ws) return;
      try {
        this.handleMessage(JSON.parse(wire));
      } catch (error) {
        this.fail(error);
      }
    });
    ws.on("unexpected-response", (request, response) => {
      if (this.ws !== ws) return;
      const error = providerHttpError({
        status: response.statusCode,
        headers: response.headers,
        provider: "GnaniAI",
        surface: "transcription",
        model: this.model,
      });
      request.destroy();
      response.destroy();
      if (response.statusCode === 408 || response.statusCode >= 500) this.connectionFailed(error);
      else this.fail(error);
    });
    ws.on("error", () => {
      if (this.ws === ws) this.connectionFailed(protocolError("stream connection failed"));
    });
    ws.on("close", (code) => {
      if (this.ws === ws) this.connectionFailed(protocolError(`stream closed (${code})`));
    });
  }

  handleMessage(event) {
    if (event.type === "error") {
      const reason = String(event.message ?? "");
      if (
        /idle|inactivity|no audio received/i.test(reason) &&
        this.serverReady &&
        !this.final &&
        !this.queue.length &&
        !this.hasUnfinalizedAudio()
      ) {
        // An unused meeting lane can idle out. Reopen when its source resumes.
        this.closeSocket();
        this.retained = [];
        this.awaitingAudio = true;
        return;
      }
      const code = /quota|credit|budget|insufficient.balance/i.test(reason)
        ? PROVIDER_ERROR_CODES.QUOTA_EXHAUSTED
        : /concurren|rate.limit|(?:maximum|too many).*(?:sessions?|streams?)/i.test(reason)
          ? PROVIDER_ERROR_CODES.RATE_LIMITED
          : /scope|forbidden|permission/i.test(reason)
            ? PROVIDER_ERROR_CODES.ACCESS_DENIED
            : /api.key|unauthoriz/i.test(reason)
              ? PROVIDER_ERROR_CODES.AUTH_FAILED
              : null;
      if (!code) throw protocolError("the service could not transcribe this session");
      throw providerError(code, { provider: "GnaniAI", surface: "transcription" });
    }
    if (event.type === "connected") {
      const config = event.config;
      if (
        config?.sample_rate !== 16000 ||
        config.chunk_size !== 512 ||
        (config.model && config.model !== this.model) ||
        (config.language_code && config.language_code !== this.headers.language_code) ||
        (config.format && config.format !== this.headers.format)
      )
        throw protocolError("the service acknowledged different recording settings");
      if (this.serverReady) return;
      clearTimeout(this.handshakeTimer);
      this.serverReady = this.isConnected = true;
      this.ready.resolve();
      this.rotateTimer = setTimeout(() => {
        this.rotating = true;
        this.pump();
      }, ROTATE_MS);
      this.pump();
      return;
    }
    if (!this.serverReady) return;
    if (event.type === "speech_start") {
      // Live Prisma reports t_ms relative to the start of PCM on this socket.
      // Older responses may omit it. Retain the clock from the worklet/tap.
      const frame =
        Number.isFinite(event.t_ms) && event.t_ms >= 0
          ? this.sessionFirstFrame + Math.floor(event.t_ms / FRAME_MS)
          : null;
      this.pendingSpeech.set(event.utterance_id ?? "current", frame);
      return;
    }
    if (event.type === "processing") {
      this.processingCount++;
      return;
    }
    if (event.type !== "transcript") return;
    const id = event.segment_id ?? event.utterance_id ?? event.segment_index;
    if (id == null || typeof event.text !== "string")
      throw protocolError("invalid final transcript");
    if (this.seen.has(id)) return;
    this.seen.add(id);
    // Recognition of a later segment can finish first. Only settle the PCM
    // checkpoint and append to dictation in the provider's source order.
    const index = event.segment_index;
    if (Number.isInteger(index)) {
      if (index === 0 && this.expectedSegment === 1) this.expectedSegment = 0;
      this.finalByIndex.set(index, event);
      while (this.finalByIndex.has(this.expectedSegment)) {
        const next = this.finalByIndex.get(this.expectedSegment);
        this.finalByIndex.delete(this.expectedSegment++);
        this.acceptFinal(next);
      }
    } else {
      this.acceptFinal(event);
    }
    if (this.committedAt) this.checkDrain();
  }

  acceptFinal(event) {
    const utterance = event.utterance_id ?? "current";
    const start = this.pendingSpeech.get(utterance);
    this.pendingSpeech.delete(utterance);
    this.processingCount = Math.max(0, this.processingCount - 1);
    let text = event.text.trim();
    if (!text && this.isMeeting && this.model === "prisma-v2.5") {
      // v2.5 may also supply the recognized words before number formatting.
      text = typeof event.output?.literal === "string" ? event.output.literal.trim() : "";
      if (!text) return; // Keep unacknowledged PCM for recovery when the meeting stops.
    }
    const duration = Math.max(0, Number(event.audio_duration_ms) || 0);
    const sentEnd = (this.retained.at(-1)?.index ?? -1) + 1;
    const startFrame =
      start ?? Math.max(this.sessionFirstFrame, sentEnd - Math.ceil(duration / FRAME_MS));
    const timestamp =
      this.retained.find((frame) => frame.index >= startFrame)?.capturedAt ??
      this.retained[0]?.capturedAt ??
      Date.now();
    // audio_duration_ms includes the VAD tail. Clamp to frames actually sent;
    // a newer utterance can already be in recognition when an earlier final lands.
    const acknowledged = Math.min(
      sentEnd,
      startFrame + Math.ceil(duration / FRAME_MS),
      ...[...this.pendingSpeech.values()].filter(Number.isFinite)
    );
    this.retained = this.retained.filter((frame) => frame.index >= acknowledged);
    this.historyIncomplete = false;
    this.retries = 0;
    if (typeof event.detected_language_code === "string")
      this.language = event.detected_language_code;
    if (text) {
      this.completedSegments.push(text);
      this.onFinalTranscript?.(
        this.isMeeting ? text : this.completedSegments.join(" "),
        Math.round(timestamp)
      );
    }
  }

  sendAudio(buffer, capturedAt) {
    if (this.closed || this.final || !buffer?.length) return false;
    if (
      this.queue.length + Math.floor((this.carry.length + buffer.length) / this.inputFrameBytes) >
      MAX_FRAMES
    ) {
      this.fail(protocolError("more than 30 seconds of audio is waiting to be sent"));
      return false;
    }
    if (this.awaitingAudio) {
      this.awaitingAudio = false;
      this.openSocket();
    }
    const at = capturedAt ?? Date.now() - (buffer.length * FRAME_MS) / this.inputFrameBytes;
    const carryBytes = this.carry.length;
    const timeAt = (offset) =>
      offset < carryBytes
        ? this.carryAt + (offset * FRAME_MS) / this.inputFrameBytes
        : at + ((offset - carryBytes) * FRAME_MS) / this.inputFrameBytes;
    const pcm = this.carry.length ? Buffer.concat([this.carry, buffer]) : buffer;
    let offset = 0;
    while (offset + this.inputFrameBytes <= pcm.length) {
      this.enqueueFrame(pcm.subarray(offset, offset + this.inputFrameBytes), timeAt(offset));
      offset += this.inputFrameBytes;
    }
    this.carry = Buffer.from(pcm.subarray(offset));
    this.carryAt = timeAt(offset);
    this.pump();
    return true;
  }

  enqueueFrame(pcm, capturedAt) {
    // A native helper can split PCM at an odd byte offset; the resampler
    // takes an Int16Array view and needs an aligned backing buffer.
    const data = this.isMeeting
      ? downsample24kTo16k(pcm.byteOffset % 2 ? Buffer.from(pcm) : pcm)
      : Buffer.from(pcm);
    this.queue.push({ data, capturedAt, index: this.nextFrame++, audible: hasSignal(data) });
  }

  pump() {
    if (!this.serverReady || this.paceTimer || this.committedAt || this.closed) return;
    if (this.rotating || !this.queue.length) {
      if (this.rotating || this.final) this.commit();
      return;
    }
    const wait = this.nextSendAt - performance.now();
    if (wait > 0) {
      this.paceTimer = setTimeout(() => {
        this.paceTimer = null;
        this.pump();
      }, Math.ceil(wait));
      return;
    }
    const frame = this.queue.shift();
    this.sessionFirstFrame ??= frame.index;
    this.retained.push(frame);
    if (this.retained.length > MAX_FRAMES) {
      if (this.retained.shift().audible) this.historyIncomplete = true;
    }
    // Each callback either sends a single frame or arms the next tick. Never
    // catch up with a burst after a cold handshake or a stalled event loop.
    const now = performance.now();
    this.nextSendAt = this.nextSendAt
      ? Math.max(now + FRAME_MS - 1, this.nextSendAt + FRAME_MS)
      : now + FRAME_MS;
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.connectionFailed(protocolError("stream closed during audio delivery"));
      return;
    }
    this.ws.send(frame.data);
    this.audioBytesSent += FRAME_BYTES;
    this.paceTimer = setTimeout(
      () => {
        this.paceTimer = null;
        this.pump();
      },
      Math.ceil(this.nextSendAt - now)
    );
  }

  commit() {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.connectionFailed(protocolError("stream closed before the final utterance"));
      return;
    }
    this.committedAt = Date.now();
    this.ws.send(JSON.stringify({ type: "commit" }));
    this.checkDrain();
  }

  checkDrain() {
    clearTimeout(this.drainTimer);
    const elapsed = Date.now() - this.committedAt;
    if (elapsed >= QUIET_MS && !this.hasUnfinalizedAudio()) {
      if (this.rotating && (!this.final || this.queue.length)) {
        this.closeSocket();
        this.retained = [];
        this.rotating = false;
        this.openSocket();
      } else {
        this.final?.resolve(this.result());
        this.close();
      }
      return;
    }
    if (elapsed >= DRAIN_MS) {
      if (!this.recoverUnansweredCommit?.()) {
        this.fail(protocolError("timed out waiting for the last utterance"));
      }
      return;
    }
    this.drainTimer = setTimeout(
      () => this.checkDrain(),
      elapsed < QUIET_MS ? QUIET_MS - elapsed : DRAIN_MS - elapsed
    );
  }

  hasUnfinalizedAudio() {
    return (
      this.pendingSpeech.size ||
      this.processingCount ||
      this.finalByIndex.size ||
      this.retained.some((frame) => frame.audible) ||
      this.historyIncomplete
    );
  }

  connectionFailed(error) {
    // Recover a dropped socket on the same immutable credential. Re-send
    // only audio since the last final, plus PCM captured during reconnect.
    if (this.committedAt && this.final && !this.queue.length && !this.hasUnfinalizedAudio()) {
      this.final.resolve(this.result());
      this.close();
      return;
    }
    if (this.recoverUnansweredCommit?.()) return;
    const retryLimit = this.isConnected ? 2 : 1;
    if (this.historyIncomplete || this.retries >= retryLimit) {
      this.fail(error);
      return;
    }
    this.retries++;
    this.closeSocket();
    this.rotating = false;
    this.queue = [...this.retained, ...this.queue];
    this.retained = [];
    this.retryTimer = setTimeout(() => this.openSocket(), 250 * this.retries);
  }

  async finalize() {
    if (this.failure) throw this.failure;
    if (this.final) return this.final.promise;
    if (this.closed) throw protocolError("recording was cancelled");
    this.final = Promise.withResolvers();
    if (this.awaitingAudio && !this.carry.length) {
      this.final.resolve(this.result());
      this.close();
      return this.final.promise;
    }
    if (this.awaitingAudio) {
      this.awaitingAudio = false;
      this.openSocket();
    }
    if (this.carry.length) {
      const tail = Buffer.alloc(this.inputFrameBytes);
      this.carry.copy(tail);
      this.enqueueFrame(tail, this.carryAt);
      this.carry = Buffer.alloc(0);
    }
    this.pump();
    return this.final.promise;
  }

  result() {
    return {
      text: this.completedSegments.join(" "),
      model: this.model,
      language: this.language,
      audioBytesSent: this.audioBytesSent,
      ...(this.failure && { incomplete: true }),
    };
  }

  fail(error) {
    if (this.closed) return;
    const active = this.isConnected;
    this.failure = error;
    this.ready?.reject(error);
    this.final?.reject(error);
    this.close();
    if (active) {
      // Each instance owns bounded recovery and reports terminal failure to its
      // lane. Opening a second pair of meeting sockets could exceed the key cap.
      error.fatal = true;
      if (this.onConnectionLost && !this.final) this.onConnectionLost(error);
      else this.onError?.(error);
    }
  }

  closeSocket() {
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.paceTimer);
    clearTimeout(this.rotateTimer);
    clearTimeout(this.drainTimer);
    this.paceTimer = this.committedAt = null;
    this.serverReady = false;
    const socket = this.ws;
    this.ws = null;
    if (socket?.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket?.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.tailRequest?.abort();
    this.isConnected = false;
    this.headers = null;
    clearTimeout(this.retryTimer);
    this.closeSocket();
    this.queue = this.retained = [];
    this.carry = Buffer.alloc(0);
    this.onClose?.();
  }

  async disconnect() {
    if (!this.closed) {
      const error = protocolError("recording was cancelled");
      this.ready?.reject(error);
      this.final?.reject(error);
      this.close();
    }
    return this.result();
  }
}

class GnaniMeetingStreaming extends GnaniRealtimeStreaming {
  constructor(WebSocketImpl) {
    super(WebSocketImpl);
    this.isMeeting = true;
    // The meeting capture pipeline delivers 24 kHz mono PCM16.
    this.inputFrameBytes = (FRAME_BYTES * 3) / 2;
  }

  // A live v2.5 socket can detect speech but never return the final. At stop,
  // send only this source's unacknowledged audio using the original credential.
  recoverUnansweredCommit() {
    if (this.model !== "prisma-v2.5" || !this.final || !this.committedAt || this.historyIncomplete)
      return false;
    const firstAudible = this.retained.find((frame) => frame.audible);
    if (!firstAudible) return false;
    this.closeSocket();
    this.transcribeMeetingTail(firstAudible.capturedAt).catch((error) => this.fail(error));
    return true;
  }

  async transcribeMeetingTail(capturedAt) {
    this.tailRequest = new AbortController();
    const pcm = Buffer.concat(this.retained.map((frame) => frame.data));
    const { text, failedChunks } = await transcribeGnaniRecording({
      audioBuffer: pcm16ToWav(pcm),
      apiKey: this.headers["x-api-key-id"],
      model: this.model,
      language: this.headers.language_code,
      signal: this.tailRequest.signal,
    });
    this.tailRequest.signal.throwIfAborted();
    if (!text || failedChunks) throw protocolError("could not recover the last utterance");
    this.completedSegments.push(text);
    this.onFinalTranscript?.(text, Math.round(capturedAt));
    this.final.resolve(this.result());
    this.close();
  }

  async disconnect({ commit = true } = {}) {
    if (commit && !this.closed && (this.nextFrame || this.carry.length)) {
      try {
        return await this.finalize();
      } catch {
        // onError reports an incomplete tail; already delivered finals remain available.
      }
    }
    return super.disconnect();
  }
}

module.exports = { GnaniRealtimeStreaming, GnaniMeetingStreaming };
