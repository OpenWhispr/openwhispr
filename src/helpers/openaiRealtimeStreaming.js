const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const WEBSOCKET_TIMEOUT_MS = 15000;
const DISCONNECT_TIMEOUT_MS = 3000;
const SAMPLE_RATE = 24000;
const COLD_START_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 seconds of 16-bit PCM
const KEEPALIVE_INTERVAL_MS = 15000;

// A socket factory does network work before the socket exists, so the dial
// must be bounded; a socket resolving after the deadline is closed, not leaked.
async function createSocketWithTimeout(createSocket, timeoutMs) {
  const socketPromise = createSocket();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      socketPromise.then((socket) => socket?.close?.()).catch(() => {});
      reject(new Error("Realtime socket setup timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([socketPromise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class OpenAIRealtimeStreaming {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.completedSegments = [];
    this.currentPartial = "";
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.isDisconnecting = false;
    this.audioBytesSent = 0;
    this.model = "gpt-4o-mini-transcribe";
    this.inputRate = SAMPLE_RATE;
    this.captureRate = SAMPLE_RATE;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.speechStartedAt = null;
    this.bufferingAudio = false;
    this.keepAliveInterval = null;
  }

  // Starts buffering audio immediately, before the WebSocket even exists —
  // covers the token-fetch + handshake window so sendAudio() doesn't drop
  // frames while a connection is still being established.
  beginConnecting() {
    this.bufferingAudio = true;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
  }

  getFullTranscript() {
    return this.completedSegments.join(" ");
  }

  async connect(options = {}) {
    const { apiKey, model, preconfigured, inputRate, captureRate, createSocket } = options;
    if (!apiKey) throw new Error("OpenAI API key is required");

    if (this.isConnected || this.isConnecting) {
      debugLogger.debug("OpenAI Realtime already connected/connecting");
      return;
    }

    // Callers may already be buffering (beginConnecting() called before the
    // apiKey was fetched) — don't wipe audio collected during that window.
    if (!this.bufferingAudio) this.beginConnecting();

    this.isConnecting = true;
    this.model = model || "gpt-4o-mini-transcribe";
    this.preconfigured = !!preconfigured;
    this.inputRate = inputRate || SAMPLE_RATE;
    this.captureRate = captureRate || this.inputRate;
    this.completedSegments = [];
    this.currentPartial = "";
    this.audioBytesSent = 0;
    this.speechStartedAt = null;

    const url = "wss://api.openai.com/v1/realtime?intent=transcription";
    debugLogger.debug("OpenAI Realtime connecting", { model: this.model });

    // Attested providers (Tinfoil) supply their socket via an async factory.
    let ws;
    try {
      ws = createSocket
        ? await createSocketWithTimeout(createSocket, WEBSOCKET_TIMEOUT_MS)
        : new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch (err) {
      this.isConnecting = false;
      this.cleanup();
      throw err;
    }

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.isConnecting = false;
        this.cleanup();
        reject(new Error("OpenAI Realtime connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = ws;

      this.ws.on("open", () => {
        debugLogger.debug("OpenAI Realtime WebSocket opened");
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data);
      });

      this.ws.on("error", (error) => {
        debugLogger.error("OpenAI Realtime WebSocket error", { error: error.message });
        this.isConnecting = false;
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
        this.isConnecting = false;
        debugLogger.debug("OpenAI Realtime WebSocket closed", {
          code,
          reason: reason?.toString(),
          wasActive,
        });
        if (this.pendingReject) {
          this.pendingReject(new Error(`WebSocket closed before ready (code: ${code})`));
          this.pendingReject = null;
          this.pendingResolve = null;
        }
        this.cleanup();
        if (wasActive && !this.isDisconnecting) {
          this.onSessionEnd?.({ text: this.getFullTranscript() });
        }
      });
    });
  }

  handleMessage(data) {
    try {
      const event = JSON.parse(data.toString());

      switch (event.type) {
        case "session.created": {
          if (this.preconfigured) {
            // Server-side ephemeral token already configured the session;
            // sending an update would strip language and noise-reduction.
            debugLogger.debug("OpenAI Realtime session created (preconfigured)", {
              model: this.model,
            });
            this._markConnected();
          } else {
            debugLogger.debug("OpenAI Realtime session created, sending configuration", {
              model: this.model,
            });
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
            this.ws.send(
              JSON.stringify({
                type: "session.update",
                session: {
                  type: "transcription",
                  audio: {
                    input: {
                      format: { type: "audio/pcm", rate: this.inputRate },
                      transcription: { model: this.model },
                      turn_detection: {
                        type: "server_vad",
                        threshold: 0.6,
                        silence_duration_ms: 600,
                        prefix_padding_ms: 500,
                      },
                    },
                  },
                },
              })
            );
          }
          break;
        }

        case "session.updated": {
          if (this.pendingResolve) {
            debugLogger.debug("OpenAI Realtime session configured", {
              model: this.model,
            });
            this._markConnected();
          }
          break;
        }

        case "conversation.item.input_audio_transcription.delta": {
          const delta = event.delta || "";
          if (delta) {
            this.currentPartial += delta;
            this.onPartialTranscript?.(this.currentPartial);
          }
          break;
        }

        case "conversation.item.input_audio_transcription.completed": {
          const transcript = (event.transcript || "").trim();
          if (transcript) {
            this.completedSegments.push(transcript);
          }
          this.currentPartial = "";
          const speechTimestamp = this.speechStartedAt || Date.now();
          this.speechStartedAt = null;
          if (transcript) {
            const fullText = this.getFullTranscript();
            this.onFinalTranscript?.(fullText, speechTimestamp);
            debugLogger.debug("OpenAI Realtime turn completed", {
              turnText: transcript.slice(0, 100),
              totalLength: fullText.length,
              segments: this.completedSegments.length,
            });
          }
          break;
        }

        case "input_audio_buffer.speech_started":
          this.speechStartedAt = Date.now();
          break;
        case "input_audio_buffer.speech_stopped":
        case "input_audio_buffer.committed":
          break;

        case "error": {
          const errCode = event.error?.code;
          const errMsg = event.error?.message || "OpenAI Realtime error";
          const isEmptyBuffer =
            errCode === "input_audio_buffer_commit_empty" ||
            errMsg.includes("buffer too small") ||
            errMsg.includes("commit_empty");
          if (isEmptyBuffer) {
            debugLogger.debug("OpenAI Realtime empty buffer (server VAD already committed)", {
              code: errCode,
            });
          } else {
            debugLogger.error("OpenAI Realtime error event", {
              code: errCode,
              message: errMsg,
            });
          }
          this.onError?.(new Error(errMsg));
          break;
        }

        default:
          break;
      }
    } catch (err) {
      debugLogger.error("OpenAI Realtime message parse error", { error: err.message });
    }
  }

  _markConnected() {
    this.isConnected = true;
    this.isConnecting = false;
    clearTimeout(this.connectionTimeout);
    this.startKeepAlive();
    if (this.pendingResolve) {
      this.pendingResolve();
      this.pendingResolve = null;
      this.pendingReject = null;
    }
  }

  // A warm connection sits idle between dictations for up to 5 minutes and is
  // reused with no other liveness check; a network path that dies silently
  // (NAT/firewall drop, sleep/wake, VPN toggle) leaves isConnected stuck true
  // and the next recording gets sent into a dead socket.
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
        debugLogger.debug("OpenAI Realtime keep-alive missed pong, terminating stale connection");
        socket.terminate();
        return;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch (err) {
        debugLogger.debug("OpenAI Realtime keep-alive ping failed", { error: err.message });
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

  // OpenAI rejects PCM session rates below 24kHz, so 16kHz capture can't be
  // declared as-is; it is upsampled to the declared rate before sending.
  _resampleToInputRate(pcmBuffer) {
    if (this.captureRate === this.inputRate) return pcmBuffer;
    const src = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2);
    const ratio = this.inputRate / this.captureRate;
    const out = new Int16Array(Math.floor(src.length * ratio));
    for (let i = 0; i < out.length; i++) {
      const pos = i / ratio;
      const low = Math.floor(pos);
      const high = Math.min(low + 1, src.length - 1);
      out[i] = Math.round(src[low] + (src[high] - src[low]) * (pos - low));
    }
    return Buffer.from(out.buffer);
  }

  sendAudio(pcmBuffer) {
    const isOpen = this.ws?.readyState === WebSocket.OPEN;

    if (!isOpen) {
      if (this.bufferingAudio && this.coldStartBufferSize < COLD_START_BUFFER_MAX) {
        const copy = Buffer.from(pcmBuffer);
        this.coldStartBuffer.push(copy);
        this.coldStartBufferSize += copy.length;
      }
      return false;
    }

    if (this.coldStartBuffer.length > 0) {
      debugLogger.debug("OpenAI Realtime flushing cold-start buffer", {
        chunks: this.coldStartBuffer.length,
        bytes: this.coldStartBufferSize,
      });
      for (const buf of this.coldStartBuffer) {
        const audio = this._resampleToInputRate(buf);
        this.ws.send(
          JSON.stringify({ type: "input_audio_buffer.append", audio: audio.toString("base64") })
        );
        this.audioBytesSent += audio.length;
      }
      this.coldStartBuffer = [];
      this.coldStartBufferSize = 0;
    }

    const audio = this._resampleToInputRate(Buffer.from(pcmBuffer));
    this.ws.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: audio.toString("base64") })
    );
    this.audioBytesSent += audio.length;
    return true;
  }

  async disconnect() {
    debugLogger.debug("OpenAI Realtime disconnect", {
      audioBytesSent: this.audioBytesSent,
      segments: this.completedSegments.length,
      textLength: this.getFullTranscript().length,
      readyState: this.ws?.readyState,
    });

    if (!this.ws) return { text: this.getFullTranscript() };

    this.isDisconnecting = true;

    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.once("open", () => this.ws?.close());
      const result = { text: this.getFullTranscript() };
      this.isDisconnecting = false;
      return result;
    }

    if (this.ws.readyState === WebSocket.OPEN) {
      if (this.audioBytesSent > 0) {
        const prevOnFinal = this.onFinalTranscript;
        const prevOnError = this.onError;

        await new Promise((resolve) => {
          const tid = setTimeout(() => {
            debugLogger.debug("OpenAI Realtime commit timeout, using accumulated text");
            resolve();
          }, DISCONNECT_TIMEOUT_MS);

          const done = () => {
            clearTimeout(tid);
            this.onFinalTranscript = prevOnFinal;
            this.onError = prevOnError;
            resolve();
          };

          this.onFinalTranscript = (text) => {
            prevOnFinal?.(text);
            done();
          };

          this.onError = (err) => {
            if (
              err?.message?.includes("buffer too small") ||
              err?.message?.includes("commit_empty")
            ) {
              done();
            } else {
              prevOnError?.(err);
            }
          };

          try {
            this.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          } catch {
            done();
          }
        });
      }

      this.ws.close();
    }

    const result = { text: this.getFullTranscript() };
    this.cleanup();
    this.isDisconnecting = false;
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
}

module.exports = OpenAIRealtimeStreaming;
