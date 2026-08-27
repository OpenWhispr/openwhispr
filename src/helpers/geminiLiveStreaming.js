const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const SAMPLE_RATE = 16000;
const WEBSOCKET_TIMEOUT_MS = 15000;
// The final transcript lands ~500ms after audioStreamEnd, ~2s at the tail.
const DISCONNECT_TIMEOUT_MS = 3000;
const KEEPALIVE_INTERVAL_MS = 15000;
const COLD_START_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 seconds of 16-bit PCM
// Google documents a 1000-phrase ceiling but only promises quality up to 100;
// the batch dictionary paths truncate the same array at 100.
const MAX_CUSTOM_VOCABULARY = 100;
const GEMINI_LIVE_MODEL = "gemini-3.5-transcribe-live";

// In managed mode the model comes from the BYOK-shaped settings, which still
// hold another provider's id, so anything but a Gemini id is ignored.
const resolveLiveModel = (model) =>
  model && model.startsWith("gemini-") ? model : GEMINI_LIVE_MODEL;

const WS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage";

// The two Live methods are auth-disjoint: BidiGenerateContent accepts only
// `key`, BidiGenerateContentConstrained only `access_token` (an auth_tokens
// resource name). Crossing them closes the socket with 1007 right after a
// successful HTTP 101, so the credential kind decides the method, not the URL.
function buildGeminiLiveUrl({ mode, token }) {
  if (mode === "byok") {
    return `${WS_BASE}.v1beta.GenerativeService.BidiGenerateContent?key=${token}`;
  }
  return `${WS_BASE}.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${token}`;
}

// Every Live failure arrives as a close frame after the upgrade succeeded (the
// socket's `error` event never carries them), and the server truncates close
// reasons to the 123-byte WebSocket limit — decide on the code, never on the
// tail of the reason.
function closeFrameError(code, reason) {
  if (code === 1011) {
    // "Token has been used too many times" / "Token has expired". The managed
    // tokens are single-use, so this is the one retryable auth failure; byok
    // re-handshakes with the same raw key and never sees it.
    return Object.assign(new Error(reason || "Gemini Live session token expired"), {
      code: "AUTH_EXPIRED",
    });
  }
  if (code === 1007 && reason.startsWith("API key not valid")) {
    return Object.assign(new Error("Invalid Gemini API key. Check your key in Settings."), {
      code: "INVALID_KEY",
    });
  }
  return new Error(`Gemini Live closed before ready (code: ${code}${reason ? `, ${reason}` : ""})`);
}

class GeminiLiveStreaming {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.isDisconnecting = false;
    this.completedSegments = [];
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.onConnectionLost = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.keepAliveInterval = null;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.bufferingAudio = false;
    this.audioBytesSent = 0;
    this.currentModel = GEMINI_LIVE_MODEL;
    this._connectionLossNotified = false;
    this._audioStreamEndSent = false;
    this._turnEndResolve = null;
  }

  // Starts buffering audio before the socket exists, covering the token fetch
  // and the 350ms-1.4s handshake so sendAudio() doesn't drop the first words.
  beginConnecting() {
    this.bufferingAudio = true;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
  }

  getFullTranscript() {
    return this.completedSegments.join(" ");
  }

  // Test seam: overridden to point at a loopback server.
  buildWebSocketUrl(options) {
    return buildGeminiLiveUrl(options);
  }

  buildSetupMessage({ model, language, keyterms } = {}) {
    const customVocabulary = (keyterms || [])
      .map((term) => String(term).trim())
      .filter(Boolean)
      .slice(0, MAX_CUSTOM_VOCABULARY);
    const inputAudioTranscription = {};
    // `languageCodes` on its own costs punctuation and sentence casing, and an
    // invalid locale is accepted silently — only ever send a language the user
    // picked explicitly ("auto" is stripped upstream).
    if (language) inputAudioTranscription.languageCodes = [language];
    if (customVocabulary.length) inputAudioTranscription.customVocabulary = customVocabulary;

    return {
      setup: {
        model: `models/${resolveLiveModel(model)}`,
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription,
      },
    };
  }

  async connect(options = {}) {
    const { token, mode, refreshToken } = options;
    if (!token) {
      throw Object.assign(new Error("Gemini API key not configured. Add your key in Settings."), {
        code: "API_KEY_MISSING",
      });
    }

    if (this.isConnected || this.isConnecting) {
      debugLogger.debug("Gemini Live already connected/connecting");
      return;
    }

    if (!this.bufferingAudio) this.beginConnecting();
    this.completedSegments = [];
    this.audioBytesSent = 0;
    this.currentModel = resolveLiveModel(options.model);
    this._connectionLossNotified = false;
    this._audioStreamEndSent = false;

    try {
      await this._openSocket(options);
    } catch (err) {
      if (err.code !== "AUTH_EXPIRED" || mode === "byok" || !refreshToken) throw err;
      debugLogger.debug("Gemini Live re-minting single-use token after 1011 close");
      this.bufferingAudio = true;
      await this._openSocket({ ...options, token: await refreshToken() });
    }
  }

  _openSocket(options) {
    const url = this.buildWebSocketUrl(options);
    debugLogger.debug("Gemini Live connecting", {
      mode: options.mode === "byok" ? "byok" : "openwhispr",
      model: this.currentModel,
    });

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.isConnecting = true;
      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("Gemini Live connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        // Audio sent before setupComplete is discarded by the server, so the
        // setup message is the only thing that goes out on open.
        this.ws.send(JSON.stringify(this.buildSetupMessage(options)));
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (error) => {
        const wasActive = this.isConnected;
        debugLogger.error("Gemini Live WebSocket error", { error: error.message });
        this.cleanup();
        this._rejectPending(error);
        if (wasActive && !this.isDisconnecting) {
          this._notifyConnectionLost(error);
        } else if (!this.isDisconnecting) {
          this.onError?.(error);
        }
      });

      this.ws.on("close", (code, reason) => {
        const wasActive = this.isConnected;
        const reasonText = reason?.toString() || "";
        debugLogger.debug("Gemini Live WebSocket closed", { code, reason: reasonText, wasActive });
        this._resolveTurnEnd();
        this.cleanup();
        const error = closeFrameError(code, reasonText);
        this._rejectPending(error);
        if (wasActive && !this.isDisconnecting) {
          // A session killed mid-dictation (the ~10 minute cap, a dead network)
          // still hands over what it transcribed; there is no resumption handle
          // to reconnect with, so the caller finalizes with this text.
          this.onSessionEnd?.({ text: this.getFullTranscript() });
          this._notifyConnectionLost(error);
        }
      });
    });
  }

  // The complete server vocabulary is `setupComplete` plus
  // `serverContent.{speechState, interimInputTranscription, inputTranscription,
  // generationComplete}`. There is no `turnComplete`, no `usageMetadata` and no
  // `sessionResumptionUpdate` on this model, so end-of-turn is the final
  // transcript arriving with `generationComplete` in the same millisecond.
  handleMessage(data) {
    try {
      const message = JSON.parse(data.toString());

      if (message.setupComplete) this._markConnected();

      const serverContent = message.serverContent;
      if (!serverContent) return;

      // Partials are revised, not appended to ("The quick brown" becomes
      // "the quick brown fox"), so consumers must replace the whole string.
      const partial = serverContent.interimInputTranscription?.text;
      if (partial) this.onPartialTranscript?.(partial);

      const final = serverContent.inputTranscription?.text?.trim();
      if (final) {
        this.completedSegments.push(final);
        const fullText = this.getFullTranscript();
        this.onFinalTranscript?.(fullText, Date.now());
        debugLogger.debug("Gemini Live turn completed", {
          turnText: final.slice(0, 100),
          totalLength: fullText.length,
          segments: this.completedSegments.length,
        });
      }

      if (serverContent.generationComplete) this._resolveTurnEnd();
    } catch (err) {
      debugLogger.error("Gemini Live message parse error", { error: err.message });
    }
  }

  _markConnected() {
    if (this.isConnected) return;
    this.isConnected = true;
    this.isConnecting = false;
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.startKeepAlive();
    debugLogger.debug("Gemini Live setup complete", { model: this.currentModel });
    // A dictation shorter than the handshake leaves every frame in the buffer,
    // and sendAudio never runs again to drain it.
    this._flushColdStartBuffer();
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
      this.pendingReject = null;
    }
  }

  _rejectPending(error) {
    if (!this.pendingReject) return;
    this.pendingReject(error);
    this.pendingReject = null;
    this.pendingResolve = null;
  }

  _notifyConnectionLost(error) {
    if (this._connectionLossNotified) return;
    this._connectionLossNotified = true;
    if (this.onConnectionLost) {
      this.onConnectionLost(error);
    } else {
      this.onError?.(error);
    }
  }

  _resolveTurnEnd() {
    if (!this._turnEndResolve) return;
    this._turnEndResolve();
    this._turnEndResolve = null;
  }

  // A warm socket sits idle between dictations with no other liveness check; a
  // network path that dies silently leaves isConnected stuck true and the next
  // recording gets sent into a dead socket.
  startKeepAlive() {
    this.stopKeepAlive();
    const socket = this.ws;
    if (!socket) return;

    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    this.keepAliveInterval = setInterval(() => {
      if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) {
        this.stopKeepAlive();
        return;
      }
      if (socket.isAlive === false) {
        debugLogger.debug("Gemini Live keep-alive missed pong, terminating stale connection");
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch (err) {
        debugLogger.debug("Gemini Live keep-alive ping failed", { error: err.message });
        socket.terminate();
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  stopKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  _sendAudioFrame(pcmBuffer) {
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: { data: pcmBuffer.toString("base64"), mimeType: `audio/pcm;rate=${SAMPLE_RATE}` },
        },
      })
    );
    this.audioBytesSent += pcmBuffer.length;
  }

  sendAudio(pcmBuffer) {
    // The capture worklet ends its stream with a "flushed" string sentinel;
    // only s16 PCM (even byte length) is audio, and only audioStreamEnd closes
    // a Gemini turn.
    if (!pcmBuffer || pcmBuffer.length % 2 !== 0) return false;

    if (this.ws?.readyState !== WebSocket.OPEN || !this.isConnected) {
      if (this.bufferingAudio && this.coldStartBufferSize < COLD_START_BUFFER_MAX) {
        const copy = Buffer.from(pcmBuffer);
        this.coldStartBuffer.push(copy);
        this.coldStartBufferSize += copy.length;
      }
      return false;
    }

    this._flushColdStartBuffer();
    this._sendAudioFrame(Buffer.from(pcmBuffer));
    return true;
  }

  _flushColdStartBuffer() {
    if (this.coldStartBuffer.length === 0) return;
    debugLogger.debug("Gemini Live flushing cold-start buffer", {
      chunks: this.coldStartBuffer.length,
      bytes: this.coldStartBufferSize,
    });
    for (const buffered of this.coldStartBuffer) {
      this._sendAudioFrame(buffered);
    }
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
  }

  // Gemini has no mid-stream finalize: audioStreamEnd ends the turn, and the
  // server answers with the final transcript. Sending it from here (the stop
  // sequence calls finalize() before it waits for text) buys back the wait.
  finalize() {
    if (this.ws?.readyState !== WebSocket.OPEN || this._audioStreamEndSent) return false;
    this._audioStreamEndSent = true;
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
    debugLogger.debug("Gemini Live audioStreamEnd sent", { audioBytesSent: this.audioBytesSent });
    return true;
  }

  async disconnect(closeStream = true) {
    debugLogger.debug("Gemini Live disconnect", {
      audioBytesSent: this.audioBytesSent,
      segments: this.completedSegments.length,
      textLength: this.getFullTranscript().length,
      readyState: this.ws?.readyState,
    });

    if (!this.ws) return this._takeTranscript();

    this.isDisconnecting = true;

    if (closeStream && this.ws.readyState === WebSocket.OPEN && this.isConnected) {
      this._flushColdStartBuffer();
    }

    if (closeStream && this.ws.readyState === WebSocket.OPEN && this.audioBytesSent > 0) {
      const awaitingTurnEnd = !this._audioStreamEndSent;
      this.finalize();
      if (awaitingTurnEnd) {
        let timeoutId;
        await Promise.race([
          new Promise((resolve) => {
            this._turnEndResolve = resolve;
          }),
          new Promise((resolve) => {
            timeoutId = setTimeout(() => {
              debugLogger.debug("Gemini Live final transcript timeout, using accumulated text");
              resolve();
            }, DISCONNECT_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timeoutId);
        this._turnEndResolve = null;
      }
    }

    const result = this._takeTranscript();
    this.cleanup();
    this.isDisconnecting = false;
    return result;
  }

  _takeTranscript() {
    const result = { text: this.getFullTranscript() };
    this.completedSegments = [];
    return result;
  }

  cleanup() {
    clearTimeout(this.connectionTimeout);
    this.connectionTimeout = null;
    this.stopKeepAlive();

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
    this.bufferingAudio = false;
  }

  getStatus() {
    return { isConnected: this.isConnected, isConnecting: this.isConnecting };
  }
}

module.exports = { GeminiLiveStreaming, buildGeminiLiveUrl, GEMINI_LIVE_MODEL };
