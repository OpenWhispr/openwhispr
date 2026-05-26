const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const WEBSOCKET_TIMEOUT_MS = 30000;
const TERMINATION_TIMEOUT_MS = 5000;
const CONFIG_TIMEOUT_MS = 10000;
const TOKEN_EXPIRY_BUFFER_MS = 30000;
const MAX_DEBUG_STRING_LENGTH = 300;
const AUDIO_BUFFER_MAX_BYTES = 5 * 1024 * 1024;
const WSS_CLOSE_TIMEOUT_MS = 60000;

function buildAudioFormatString(opts = {}) {
  return (
    opts.audioFormat ||
    `audio/pcm; rate=${opts.sampleRate || 16000}; channels=${opts.channels || 1}; bits=${opts.bitsPerSample || 16}`
  );
}

function normalizeLanguage(lang) {
  return lang && lang !== "auto" ? lang : "en";
}

function truncateDebugString(value) {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_DEBUG_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_DEBUG_STRING_LENGTH)}...`;
}

function buildCortiErrorMessage(message, fallbackSummary) {
  if (typeof message?.message === "string" && message.message.trim()) {
    return message.message.trim();
  }

  if (typeof message?.error === "string" && message.error.trim()) {
    return message.error.trim();
  }

  if (typeof message?.code === "string" && message.code.trim()) {
    return `Corti streaming error (${message.code.trim()})`;
  }

  if (fallbackSummary && typeof fallbackSummary === "object") {
    const summarizedKeys = Object.keys(fallbackSummary).filter((key) => key !== "type");
    if (summarizedKeys.length > 0) {
      return `Corti streaming error: ${JSON.stringify(fallbackSummary)}`;
    }
  }

  return "Corti streaming error";
}

function summarizeDebugValue(value) {
  if (typeof value === "string") return truncateDebugString(value);
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => summarizeDebugValue(item));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, summarizeDebugValue(entryValue)])
  );
}

class CortiTranscribeStreaming {
  constructor(environmentManager, cortiOAuth) {
    this.environmentManager = environmentManager;
    this.cortiOAuth = cortiOAuth;
    this.ws = null;
    this.isConnected = false;
    this.isConfigured = false;
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.configResolve = null;
    this.configReject = null;
    this.connectionTimeout = null;
    this.configTimeout = null;
    this.closeResolve = null;
    this.accumulatedText = "";
    this.finalSegments = [];
    this.audioBytesSent = 0;
    this.isDisconnecting = false;
    this.hasStreamError = false;
    this.lastConfigSummary = null;
    this.lastMessageSummary = null;
    this.clientCredsCache = { token: null, expiresAt: 0 };
    this.connectionOptions = null;
    this.audioBuffer = [];
    this.audioBufferBytes = 0;
    this.isWarmIdle = false;
    this.idleCloseTimer = null;
  }

  get completedSegments() {
    return this.finalSegments;
  }

  async _fetchToken() {
    // PKCE first — uses stored refresh token, no secret required
    if (this.cortiOAuth) {
      try {
        return await this.cortiOAuth.getValidAccessToken();
      } catch {
        // Fall through to client_credentials if a secret is configured
      }
    }

    // Client credentials fallback
    const env = this.environmentManager.getCortiEnvironment();
    const clientId = this.environmentManager.getCortiClientId();
    const clientSecret = this.environmentManager.getCortiClientSecret();
    const region = env.region;
    const tenant = this.environmentManager.getCortiTenant() || env.defaultTenant;

    if (!clientId || !clientSecret) {
      throw new Error(
        "Not connected to Corti. Connect via Settings or configure a Client Secret."
      );
    }

    const configKey = `${clientId}:${region}:${tenant}`;
    if (
      this.clientCredsCache.token &&
      this.clientCredsCache.configKey === configKey &&
      Date.now() < this.clientCredsCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS
    ) {
      return this.clientCredsCache.token;
    }

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "openid",
    });

    const res = await fetch(
      `https://auth.${region}.corti.app/realms/${tenant}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Corti token fetch failed (${res.status}): ${body}`);
    }

    const data = await res.json();
    this.clientCredsCache.token = data.access_token;
    this.clientCredsCache.expiresAt = Date.now() + (data.expires_in || 300) * 1000;
    this.clientCredsCache.configKey = configKey;
    debugLogger.debug("Corti client_credentials token fetched", { expiresIn: data.expires_in });
    return this.clientCredsCache.token;
  }

  _optionsCompatible(options) {
    if (!this.connectionOptions) return false;
    if (normalizeLanguage(this.connectionOptions.language) !== normalizeLanguage(options.language)) {
      return false;
    }
    return buildAudioFormatString(this.connectionOptions) === buildAudioFormatString(options);
  }

  _buildWssUrl(token) {
    const env = this.environmentManager.getCortiEnvironment();
    const region = env.region;
    const tenant = this.environmentManager.getCortiTenant() || env.defaultTenant;
    const encodedToken = encodeURIComponent(`Bearer ${token}`);
    return `wss://api.${region}.corti.app/audio-bridge/v2/transcribe?tenant-name=${encodeURIComponent(tenant)}&token=${encodedToken}`;
  }

  async connect(options = {}) {
    if (
      this.isWarmIdle &&
      this.isConnected &&
      this.isConfigured &&
      this.ws?.readyState === WebSocket.OPEN &&
      this._optionsCompatible(options)
    ) {
      debugLogger.debug("Corti reusing warm WSS connection");
      clearTimeout(this.idleCloseTimer);
      this.idleCloseTimer = null;
      this.isWarmIdle = false;
      this.accumulatedText = "";
      this.finalSegments = [];
      this.audioBytesSent = 0;
      this.hasStreamError = false;
      this.lastMessageSummary = null;
      return;
    }

    if (this.ws) {
      // Either still connected with incompatible options, or warm-idle expired
      // raced; tear down before starting fresh.
      debugLogger.debug("Corti tearing down stale WSS before reconnect", {
        isWarmIdle: this.isWarmIdle,
        readyState: this.ws.readyState,
      });
      this.cleanup();
    }

    this.connectionOptions = {
      language: options.language,
      audioFormat: options.audioFormat,
      sampleRate: options.sampleRate,
      channels: options.channels,
      bitsPerSample: options.bitsPerSample,
    };
    this.accumulatedText = "";
    this.finalSegments = [];
    this.audioBytesSent = 0;
    this.audioBuffer = [];
    this.audioBufferBytes = 0;
    this.hasStreamError = false;
    this.lastMessageSummary = null;

    let token;
    try {
      token = await this._fetchToken();
    } catch (err) {
      debugLogger.error("Corti token fetch failed during connect", { error: err.message });
      throw err;
    }

    const url = this._buildWssUrl(token);
    debugLogger.debug("Corti streaming connecting");

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("Corti WebSocket connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        debugLogger.debug("Corti WebSocket opened, sending config");
        clearTimeout(this.connectionTimeout);
        this.connectionTimeout = null;

        const lang = normalizeLanguage(options.language);
        const audioFormat = buildAudioFormatString(options);

        const configMsg = {
          type: "config",
          configuration: {
            primaryLanguage: lang,
            interimResults: true,
            automaticPunctuation: true,
            audioFormat,
          },
        };
        debugLogger.debug("Corti sending full config", configMsg);
        this.lastConfigSummary = summarizeDebugValue(configMsg);
        debugLogger.debug("Corti sending config", this.lastConfigSummary);

        this.configTimeout = setTimeout(() => {
          this.cleanup();
          if (this.pendingReject) {
            this.pendingReject(new Error("Corti CONFIG_TIMEOUT — config not accepted in time"));
            this.pendingReject = null;
            this.pendingResolve = null;
          }
        }, CONFIG_TIMEOUT_MS);

        try {
          this.ws.send(JSON.stringify(configMsg));
        } catch (err) {
          clearTimeout(this.configTimeout);
          this.configTimeout = null;
          this.cleanup();
          reject(err);
        }
      });

      this.ws.on("message", (data) => {
        this._onMessage(data);
      });

      this.ws.on("error", (error) => {
        debugLogger.error("Corti WebSocket error", {
          error: error.message,
          isConnected: this.isConnected,
          isConfigured: this.isConfigured,
          audioBytesSent: this.audioBytesSent,
          lastMessage: this.lastMessageSummary,
          lastConfig: this.lastConfigSummary,
        });
        if (error.message && (error.message.includes("401") || error.message.includes("403"))) {
          this.clientCredsCache = { token: null, expiresAt: 0, configKey: null };
        }
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
        const wasDisconnecting = this.isDisconnecting;
        const hadStreamError = this.hasStreamError;
        const wasWarmIdle = this.isWarmIdle;
        debugLogger.debug("Corti WebSocket closed", {
          code,
          reason: reason?.toString(),
          wasActive,
          hasStreamError: hadStreamError,
          isConfigured: this.isConfigured,
          isDisconnecting: wasDisconnecting,
          isWarmIdle: wasWarmIdle,
          audioBytesSent: this.audioBytesSent,
          textLength: this.accumulatedText.length,
          lastMessage: this.lastMessageSummary,
        });
        if (this.pendingReject) {
          this.pendingReject(new Error(`Corti WebSocket closed before ready (code: ${code})`));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        if (this.closeResolve) {
          this.closeResolve({ text: this.accumulatedText });
        }
        this.cleanup();
        if (wasActive && !wasDisconnecting && !hadStreamError && !wasWarmIdle) {
          this.onError?.(new Error(`Corti connection lost (code: ${code})`));
        }
      });
    });
  }

  _onMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      debugLogger.error("Corti message parse error", { error: err.message });
      return;
    }

    this.lastMessageSummary = summarizeDebugValue(message);

    debugLogger.debug("Corti message received", {
      type: message.type,
      keys: Object.keys(message || {}),
      payload: this.lastMessageSummary,
    });

    switch (message.type) {
      case "CONFIG_ACCEPTED":
        clearTimeout(this.configTimeout);
        this.configTimeout = null;
        this.isConnected = true;
        this.isConfigured = true;
        debugLogger.debug("Corti CONFIG_ACCEPTED — ready to stream audio");
        this._flushAudioBuffer();
        if (this.pendingResolve) {
          this.pendingResolve();
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        break;

      case "CONFIG_DENIED":
        clearTimeout(this.configTimeout);
        this.configTimeout = null;
        debugLogger.error("Corti CONFIG_DENIED", {
          payload: this.lastMessageSummary,
          lastConfig: this.lastConfigSummary,
        });
        this.cleanup();
        if (this.pendingReject) {
          this.pendingReject(
            new Error(`Corti CONFIG_DENIED: ${message.message || "invalid configuration"}`)
          );
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        break;

      case "CONFIG_TIMEOUT":
        clearTimeout(this.configTimeout);
        this.configTimeout = null;
        debugLogger.error("Corti CONFIG_TIMEOUT", {
          lastConfig: this.lastConfigSummary,
          audioBytesSent: this.audioBytesSent,
        });
        this.cleanup();
        if (this.pendingReject) {
          this.pendingReject(new Error("Corti CONFIG_TIMEOUT"));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        break;

      case "transcript": {
        const transcript = message.transcript || message.data;
        if (!transcript || !transcript.text) break;

        if (transcript.isFinal) {
          const trimmed = transcript.text.trim();
          if (trimmed) {
            this.finalSegments.push(trimmed);
            this.accumulatedText = this.finalSegments.join(" ");
            this.onFinalTranscript?.(this.accumulatedText, Date.now());
            debugLogger.debug("Corti final transcript segment", {
              text: trimmed.slice(0, 100),
              totalLength: this.accumulatedText.length,
            });
          }
        } else {
          this.onPartialTranscript?.(transcript.text);
        }
        break;
      }

      case "flushed":
        debugLogger.debug("Corti flushed — resolving close");
        if (this.closeResolve) {
          this.closeResolve({ text: this.accumulatedText });
          this.closeResolve = null;
        }
        break;

      case "error":
        this.hasStreamError = true;
        const errorMessage = buildCortiErrorMessage(message, this.lastMessageSummary);
        debugLogger.error("Corti streaming error message", {
          message: message.message,
          error: message.error,
          code: message.code,
          payload: this.lastMessageSummary,
          keys: Object.keys(message || {}),
          isConnected: this.isConnected,
          isConfigured: this.isConfigured,
          audioBytesSent: this.audioBytesSent,
          textLength: this.accumulatedText.length,
          lastConfig: this.lastConfigSummary,
        });
        this.onError?.(new Error(errorMessage));
        break;

      default:
        debugLogger.debug("Corti unknown message type", { type: message.type });
    }
  }

  sendAudio(buffer) {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)
    ) {
      return false;
    }

    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(buffer);
        this.audioBytesSent += buffer.length;
        return true;
      } catch (err) {
        debugLogger.error("Corti sendAudio error", { error: err.message });
        return false;
      }
    }

    // Pre-CONFIG_ACCEPTED window — buffer in FIFO order so no audio is lost
    // during the WSS handshake. Flushed by _flushAudioBuffer() on CONFIG_ACCEPTED.
    if (this.audioBufferBytes + buffer.length > AUDIO_BUFFER_MAX_BYTES) {
      debugLogger.warn("Corti pre-config audio buffer cap exceeded; dropping frame", {
        bufferedBytes: this.audioBufferBytes,
        droppedBytes: buffer.length,
        isConnected: this.isConnected,
        wsState: this.ws?.readyState,
      });
      return false;
    }
    this.audioBuffer.push(buffer);
    this.audioBufferBytes += buffer.length;
    return true;
  }

  _flushAudioBuffer() {
    if (!this.audioBuffer.length) return;

    const queued = this.audioBuffer;
    const queuedBytes = this.audioBufferBytes;
    this.audioBuffer = [];
    this.audioBufferBytes = 0;

    debugLogger.debug("Corti flushing pre-config audio buffer", {
      frames: queued.length,
      bytes: queuedBytes,
    });

    let flushed = 0;
    for (const chunk of queued) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
      try {
        this.ws.send(chunk);
        this.audioBytesSent += chunk.length;
        flushed += chunk.length;
      } catch (err) {
        debugLogger.error("Corti pre-config flush error", {
          error: err.message,
          flushedBytes: flushed,
        });
        break;
      }
    }

    if (flushed < queuedBytes) {
      debugLogger.warn("Corti pre-config flush incomplete", {
        flushedBytes: flushed,
        totalBytes: queuedBytes,
      });
    }
  }

  async disconnect() {
    debugLogger.debug("Corti disconnect (soft)", {
      audioBytesSent: this.audioBytesSent,
      textLength: this.accumulatedText.length,
      isWarmIdle: this.isWarmIdle,
    });

    if (!this.ws) return { text: this.accumulatedText };

    if (this.isWarmIdle) {
      // Stop pressed during the keepalive window (no recording in between);
      // return whatever text is around without disturbing the WSS.
      return { text: this.accumulatedText };
    }

    if (!this.isConnected || this.ws.readyState !== WebSocket.OPEN) {
      const result = { text: this.accumulatedText };
      this.cleanup();
      this.accumulatedText = "";
      this.finalSegments = [];
      return result;
    }

    try {
      this.ws.send(JSON.stringify({ type: "flush" }));
    } catch (err) {
      debugLogger.error("Corti flush send error", { error: err.message });
    }

    let timeoutId;
    const result = await Promise.race([
      new Promise((resolve) => {
        this.closeResolve = resolve;
      }),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          debugLogger.debug("Corti flush timeout, using accumulated text");
          resolve({ text: this.accumulatedText });
        }, TERMINATION_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timeoutId);
    this.closeResolve = null;

    const finalText = result?.text || this.accumulatedText;

    // Keep the WSS open for WSS_CLOSE_TIMEOUT_MS so a quick follow-up
    // recording can skip the connect/config round-trip.
    this.isWarmIdle = true;
    this.accumulatedText = "";
    this.finalSegments = [];
    this.audioBytesSent = 0;
    clearTimeout(this.idleCloseTimer);
    this.idleCloseTimer = setTimeout(() => {
      debugLogger.debug("Corti idle keepalive expired; closing WSS");
      this.idleCloseTimer = null;
      this.cleanup();
    }, WSS_CLOSE_TIMEOUT_MS);

    return { text: finalText };
  }

  cleanup() {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    clearTimeout(this.configTimeout);
    this.configTimeout = null;
    clearTimeout(this.idleCloseTimer);
    this.idleCloseTimer = null;

    if (this.ws) {
      try {
        this.ws.close();
      } catch (err) {
        // Ignore
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.isConfigured = false;
    this.isWarmIdle = false;
    this.closeResolve = null;
    this.hasStreamError = false;
    this.audioBuffer = [];
    this.audioBufferBytes = 0;
  }

  cleanupAll() {
    this.cleanup();
    this.clientCredsCache = { token: null, expiresAt: 0, configKey: null };
    this.finalSegments = [];
    this.audioBuffer = [];
    this.audioBufferBytes = 0;
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      isConfigured: this.isConfigured,
      audioBytesSent: this.audioBytesSent,
    };
  }
}

module.exports = CortiTranscribeStreaming;
