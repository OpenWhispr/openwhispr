const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const WEBSOCKET_TIMEOUT_MS = 15000;
const DISCONNECT_TIMEOUT_MS = 3000;
const SAMPLE_RATE = 24000;
const COLD_START_BUFFER_MAX = 3 * SAMPLE_RATE * 2; // 3 seconds of 16-bit PCM

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
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.speechStartedAt = null;
  }

  getFullTranscript() {
    return this.completedSegments.join(" ");
  }

  async connect(options = {}) {
    const { apiKey, model, preconfigured } = options;
    if (!apiKey) throw new Error("OpenAI API key is required");

    if (this.isConnected || this.isConnecting) {
      debugLogger.debug("OpenAI Realtime already connected/connecting");
      return;
    }

    this.isConnecting = true;
    this.model = model || "gpt-4o-mini-transcribe";
    this.preconfigured = !!preconfigured;
    this.completedSegments = [];
    this.currentPartial = "";
    this.audioBytesSent = 0;
    this.coldStartBuffer = [];
    this.coldStartBufferSize = 0;
    this.speechStartedAt = null;

    const url = "wss://api.openai.com/v1/realtime?intent=transcription";
    debugLogger.debug("OpenAI Realtime connecting", { model: this.model });

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.isConnecting = false;
        this.cleanup();
        reject(new Error("OpenAI Realtime connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      // Realtime moved from Beta to GA; the OpenAI-Beta header is now rejected
      // with "The Realtime Beta API is no longer supported." (#782).
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });

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
        case "transcription_session.created": {
          if (this.preconfigured) {
            // Server-side ephemeral token already configured the session;
            // sending an update would strip language and noise-reduction.
            debugLogger.debug("OpenAI Realtime session created (preconfigured)", {
              model: this.model,
            });
            this.isConnected = true;
            this.isConnecting = false;
            clearTimeout(this.connectionTimeout);
            if (this.pendingResolve) {
              this.pendingResolve();
              this.pendingResolve = null;
              this.pendingReject = null;
            }
          } else {
            debugLogger.debug("OpenAI Realtime session created, sending configuration", {
              model: this.model,
            });
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) break;
            this.ws.send(
              JSON.stringify({
                type: "transcription_session.update",
                session: {
                  input_audio_format: "pcm16",
                  input_audio_transcription: {
                    model: this.model,
                  },
                  turn_detection: {
                    type: "server_vad",
                    threshold: 0.6,
                    silence_duration_ms: 600,
                    prefix_padding_ms: 500,
                  },
                },
              })
            );
          }
          break;
        }

        case "transcription_session.updated": {
          if (this.pendingResolve) {
            this.isConnected = true;
            this.isConnecting = false;
            clearTimeout(this.connectionTimeout);
            debugLogger.debug("OpenAI Realtime session configured", {
              model: this.model,
            });
            this.pendingResolve();
            this.pendingResolve = null;
            this.pendingReject = null;
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

  sendAudio(pcmBuffer) {
    if (!this.ws) return false;

    if (this.ws.readyState !== WebSocket.OPEN) {
      if (
        this.ws.readyState === WebSocket.CONNECTING &&
        this.coldStartBufferSize < COLD_START_BUFFER_MAX
      ) {
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
        const b64 = buf.toString("base64");
        this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
        this.audioBytesSent += buf.length;
      }
      this.coldStartBuffer = [];
      this.coldStartBufferSize = 0;
    }

    const base64Audio = Buffer.from(pcmBuffer).toString("base64");
    this.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: base64Audio }));
    this.audioBytesSent += pcmBuffer.length;
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

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this.isConnected = false;
    this.isConnecting = false;
  }
}

module.exports = OpenAIRealtimeStreaming;
