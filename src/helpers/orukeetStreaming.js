const WebSocket = require("ws");

const MAX_PENDING_BYTES = 2 * 1024 * 1024;

function languageMetadata(message) {
  const language = message.language;
  const confidence = message.language_confidence;
  if (
    typeof language === "string" &&
    /^[a-z]{2}$/.test(language) &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1
  ) {
    return {
      language,
      languageConfidence: confidence,
      ...(Number.isFinite(message.language_audio_seconds) && message.language_audio_seconds > 0
        ? { languageAudioSeconds: message.language_audio_seconds }
        : {}),
    };
  }
  return { language: null, languageConfidence: null };
}

function capacityRetryDelay(requestedMs) {
  if (!Number.isFinite(requestedMs)) return 100;
  // Select a fixed local delay, rounding the server's hint up. Large hints
  // wait for the final deadline instead of overflowing Node's timer to 1 ms.
  for (const delay of [20, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 30000]) {
    if (requestedMs <= delay) return delay;
  }
  return 30000;
}

function streamingUrl(baseUrl) {
  const url = new URL(baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Use an Orukeet server URL without credentials or query parameters");
  }
  if (
    !["https:", "wss:"].includes(url.protocol) &&
    !(local && ["http:", "ws:"].includes(url.protocol))
  ) {
    throw new Error("Orukeet streaming requires HTTPS");
  }
  url.protocol = ["https:", "wss:"].includes(url.protocol) ? "wss:" : "ws:";
  url.pathname =
    url.pathname.replace(/\/$/, "").replace(/\/v1(?:\/audio\/transcriptions(?:\/stream)?)?$/, "") +
    "/v1/audio/transcriptions/stream";
  return url.toString();
}

// Upload PCM while recording; commit has an explicit final acknowledgement.
// Credentials stay in the main process and are sent only to the selected host.
class OrukeetStreaming {
  constructor({
    createSocket = (url, options, protocols) => new WebSocket(url, protocols, options),
    timeoutMs = 30000,
    retryCapacity = true,
  } = {}) {
    this.createSocket = createSocket;
    this.timeoutMs = timeoutMs;
    this.retryCapacity = retryCapacity;
    this.ws = null;
    this.isConnected = false;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.audioBytesSent = 0;
    this.currentModel = "orukeet-v0.1.0";
    this.result = null;
    this.finalPromise = null;
    this.intentionalClose = false;
  }

  beginConnecting() {
    this.connecting = true;
  }

  async connect({ baseUrl, apiKey, clientToken }) {
    if (this.intentionalClose || this.failure || this.ws) {
      throw new Error("Create a new Orukeet adapter for each recording");
    }
    if (Boolean(apiKey) === Boolean(clientToken)) {
      throw new Error("Supply exactly one Orukeet service key or client token");
    }
    if (clientToken && !/^[A-Za-z0-9._-]{1,96}$/.test(clientToken)) {
      throw new Error("Invalid Orukeet client token");
    }
    const url = streamingUrl(baseUrl);
    this.beginConnecting();
    this.ws = this.createSocket(
      url,
      {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        perMessageDeflate: false,
        handshakeTimeout: this.timeoutMs,
        maxPayload: MAX_PENDING_BYTES,
      },
      clientToken ? ["orukeet.pcm.v1", `auth.${clientToken}`] : undefined
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error("Orukeet connection timed out")),
        this.timeoutMs
      );
      this.connectResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this.connectReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.ws.on("message", (data) => {
        try {
          this.handleMessage(JSON.parse(data.toString()));
        } catch (error) {
          this.fail(error);
        }
      });
      this.ws.on("error", (error) => this.fail(error));
      this.ws.on("close", () => {
        if (!this.intentionalClose)
          this.fail(new Error("Orukeet connection closed before completion"));
        this.isConnected = false;
      });
    });
  }

  handleMessage(message) {
    if (this.intentionalClose || this.failure) return;
    if (message.type === "ready") {
      if (this.isConnected) throw new Error("Duplicate Orukeet ready message");
      if (
        message.sample_rate !== 16000 ||
        message.encoding !== "pcm_s16le" ||
        message.channels !== 1 ||
        !Number.isFinite(message.max_seconds) ||
        message.max_seconds <= 0 ||
        message.max_seconds > 600
      ) {
        throw new Error("Orukeet server does not support mono 16 kHz PCM");
      }
      this.maxAudioBytes = message.max_seconds * 32000;
      this.isConnected = true;
      this.connecting = false;
      for (const data of this.pendingAudio) this.writeAudio(data);
      this.pendingAudio = [];
      this.pendingBytes = 0;
      this.connectResolve?.();
      this.connectResolve = this.connectReject = null;
      this.keepAlive = setInterval(() => {
        if (this.isConnected) this.sendControl({ type: "ping" });
      }, 15000);
      this.keepAlive.unref?.();
    } else if (message.type === "language") {
      // Advisory audio-language metadata never commits a transcript or triggers a paste.
      // The final message remains authoritative for this recording.
      if (!this.isConnected || this.result) return;
      const metadata = languageMetadata(message);
      if (metadata.language) this.onLanguage?.(metadata);
    } else if (message.type === "final") {
      // A duplicate or unsolicited final must never result in a second paste.
      if (this.result) return;
      if (!this.finalResolve || typeof message.text !== "string") {
        throw new Error("Unexpected Orukeet final transcript");
      }
      this.result = {
        text: message.text || "",
        model: message.model || this.currentModel,
        audioBytesSent: this.audioBytesSent,
        inferenceMs: message.inference_ms,
        serverMs: message.server_ms,
        queueMs: message.queue_ms,
        ...("language" in message ? languageMetadata(message) : {}),
      };
      this.onFinalTranscript?.(this.result.text);
      this.finalResolve?.(this.result);
      this.clearFinal();
    } else if (message.type === "error") {
      if (message.code === "capacity" && this.finalResolve && this.retryCapacity) {
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          if (this.finalResolve) this.sendControl({ type: "commit" });
        }, capacityRetryDelay(message.retry_after_ms));
      } else {
        this.fail(new Error(message.message || `Orukeet transcription failed: ${message.code}`));
      }
    }
  }

  sendAudio(data) {
    if (this.intentionalClose || this.failure || this.finalPromise) return;
    const buffer = Buffer.from(data);
    if (buffer.length % 2) return this.fail(new Error("Orukeet requires complete PCM16 samples"));
    if (this.isConnected) {
      try {
        this.writeAudio(buffer);
      } catch (error) {
        this.fail(error);
      }
    } else if (this.connecting && this.pendingBytes + buffer.length <= MAX_PENDING_BYTES) {
      this.pendingAudio.push(buffer);
      this.pendingBytes += buffer.length;
    } else this.fail(new Error("Orukeet audio upload could not keep up"));
  }

  writeAudio(buffer) {
    if (
      this.ws.readyState !== WebSocket.OPEN ||
      this.ws.bufferedAmount + buffer.length > MAX_PENDING_BYTES ||
      this.audioBytesSent + buffer.length > this.maxAudioBytes
    ) {
      throw new Error("Orukeet recording exceeds the server or upload capacity");
    }
    this.ws.send(buffer);
    this.audioBytesSent += buffer.length;
  }

  sendControl(message) {
    try {
      if (!this.isConnected || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error("Orukeet connection closed before completion");
      }
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      this.fail(error);
    }
  }

  finalize() {
    if (this.failure) return Promise.reject(this.failure);
    if (this.result) return Promise.resolve(this.result);
    if (this.finalPromise) return this.finalPromise;
    if (!this.isConnected) return Promise.reject(new Error("Orukeet connection is not ready"));
    if (!this.audioBytesSent)
      return Promise.resolve({ text: "", model: this.currentModel, audioBytesSent: 0 });
    this.finalPromise = new Promise((resolve, reject) => {
      this.finalResolve = resolve;
      this.finalReject = reject;
      this.finalTimer = setTimeout(
        () => this.fail(new Error("Orukeet final transcript timed out")),
        this.timeoutMs
      );
      this.sendControl({ type: "commit" });
    });
    return this.finalPromise;
  }

  clearFinal() {
    clearTimeout(this.finalTimer);
    clearTimeout(this.retryTimer);
    this.finalResolve = this.finalReject = null;
  }

  fail(error) {
    if (this.failure) return;
    // The final already completed this recording. Orukeet closes a finished
    // socket when the account holds another warm one, so a later close or
    // error only ends the connection.
    if (this.result) return this.close();
    this.failure = error;
    // Before `ready` (including while main mints the session token, before
    // connect() runs), the failed start is the report and falls back on it;
    // onError is for an established stream, so a refused socket does not also
    // surface as a streaming error.
    const connecting = this.connecting || Boolean(this.connectReject);
    this.connectReject?.(error);
    this.connectResolve = this.connectReject = null;
    this.finalReject?.(error);
    this.clearFinal();
    this.close();
    if (!connecting) this.onError?.(error);
  }

  close() {
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    clearInterval(this.keepAlive);
    this.isConnected = false;
    this.connecting = false;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.ws?.close();
    this.onClose?.();
  }

  async disconnect() {
    // Stop is also used for cancellation and idle cleanup: only finalize()
    // commits audio, so cancelled recordings never submit inference.
    const result = this.result || {
      text: "",
      model: this.currentModel,
      audioBytesSent: this.audioBytesSent,
    };
    this.connectReject?.(new Error("Orukeet connection cancelled"));
    this.connectResolve = this.connectReject = null;
    this.close();
    if (this.finalReject) this.finalReject(new Error("Orukeet recording cancelled"));
    this.clearFinal();
    return result;
  }
}

module.exports = { OrukeetStreaming, streamingUrl };
