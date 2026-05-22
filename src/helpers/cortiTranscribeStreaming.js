const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const WEBSOCKET_TIMEOUT_MS = 30000;
const TERMINATION_TIMEOUT_MS = 5000;
const CONFIG_TIMEOUT_MS = 10000;
const TOKEN_EXPIRY_BUFFER_MS = 30000;

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
    this.clientCredsCache = { token: null, expiresAt: 0 };
    this.connectionOptions = null;
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
    const clientId = this.environmentManager.getCortiClientId();
    const clientSecret = this.environmentManager.getCortiClientSecret();
    const region = this.environmentManager.getCortiRegion() || "eu";
    const tenant = this.environmentManager.getCortiTenant() || "base";

    if (!clientId || !clientSecret) {
      throw new Error(
        "Not connected to Corti. Connect via Settings or configure a Client Secret."
      );
    }

    if (
      this.clientCredsCache.token &&
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
    debugLogger.debug("Corti client_credentials token fetched", { expiresIn: data.expires_in });
    return this.clientCredsCache.token;
  }

  _buildWssUrl(token) {
    const region = this.environmentManager.getCortiRegion() || "eu";
    const tenant = this.environmentManager.getCortiTenant() || "base";
    const encodedToken = encodeURIComponent(`Bearer ${token}`);
    return `wss://api.${region}.corti.app/audio-bridge/v2/transcribe?tenant-name=${encodeURIComponent(tenant)}&token=${encodedToken}`;
  }

  async connect(options = {}) {
    if (this.isConnected) {
      debugLogger.debug("Corti streaming already connected");
      return;
    }

    this.connectionOptions = {
      language: options.language,
      audioFormat: options.audioFormat,
    };
    this.accumulatedText = "";
    this.finalSegments = [];
    this.audioBytesSent = 0;

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

        const lang = options.language && options.language !== "auto" ? options.language : "en";
        const audioFormat = options.audioFormat || "audio/webm; codecs=opus";

        const configMsg = {
          type: "config",
          configuration: {
            primaryLanguage: lang,
            interimResults: true,
            automaticPunctuation: true,
            audioFormat,
          },
        };

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
        debugLogger.error("Corti WebSocket error", { error: error.message });
        if (error.message && (error.message.includes("401") || error.message.includes("403"))) {
          this.tokenCache = { token: null, expiresAt: 0 };
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
        debugLogger.debug("Corti WebSocket closed", {
          code,
          reason: reason?.toString(),
          wasActive,
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
        if (wasActive && !this.isDisconnecting) {
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

    debugLogger.debug("Corti message received", { type: message.type });

    switch (message.type) {
      case "CONFIG_ACCEPTED":
        clearTimeout(this.configTimeout);
        this.configTimeout = null;
        this.isConnected = true;
        this.isConfigured = true;
        debugLogger.debug("Corti CONFIG_ACCEPTED — ready to stream audio");
        if (this.pendingResolve) {
          this.pendingResolve();
          this.pendingResolve = null;
          this.pendingReject = null;
        }
        break;

      case "CONFIG_DENIED":
        clearTimeout(this.configTimeout);
        this.configTimeout = null;
        debugLogger.error("Corti CONFIG_DENIED", { message: message.message });
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
        debugLogger.error("Corti CONFIG_TIMEOUT");
        this.cleanup();
        if (this.pendingReject) {
          this.pendingReject(new Error("Corti CONFIG_TIMEOUT"));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        break;

      case "transcript": {
        const transcript = message.transcript;
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
        debugLogger.error("Corti streaming error message", {
          message: message.message,
          code: message.code,
        });
        this.onError?.(new Error(message.message || "Corti streaming error"));
        break;

      default:
        debugLogger.debug("Corti unknown message type", { type: message.type });
    }
  }

  sendAudio(buffer) {
    if (!this.ws || !this.isConnected || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(buffer);
      this.audioBytesSent += buffer.length;
      return true;
    } catch (err) {
      debugLogger.error("Corti sendAudio error", { error: err.message });
      return false;
    }
  }

  async disconnect() {
    debugLogger.debug("Corti disconnect", {
      audioBytesSent: this.audioBytesSent,
      textLength: this.accumulatedText.length,
    });

    if (!this.ws) return { text: this.accumulatedText };

    this.isDisconnecting = true;

    if (this.isConnected && this.ws.readyState === WebSocket.OPEN) {
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
            debugLogger.debug("Corti flush/close timeout, using accumulated text");
            resolve({ text: this.accumulatedText });
          }, TERMINATION_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timeoutId);

      this.closeResolve = null;
      const finalText = result?.text || this.accumulatedText;
      this.cleanup();
      this.isDisconnecting = false;
      this.accumulatedText = "";
      this.finalSegments = [];
      return { text: finalText };
    }

    const result = { text: this.accumulatedText };
    this.cleanup();
    this.isDisconnecting = false;
    this.accumulatedText = "";
    this.finalSegments = [];
    return result;
  }

  cleanup() {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    clearTimeout(this.configTimeout);
    this.configTimeout = null;

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
    this.closeResolve = null;
  }

  cleanupAll() {
    this.cleanup();
    this.tokenCache = { token: null, expiresAt: 0 };
    this.finalSegments = [];
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
