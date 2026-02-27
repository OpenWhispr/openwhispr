const WebSocket = require("ws");
const debugLogger = require("./debugLogger");

const WEBSOCKET_TIMEOUT_MS = 15000;
const DISCONNECT_TIMEOUT_MS = 3000;

class OpenAIRealtimeStreaming {
  constructor() {
    this.ws = null;
    this.isConnected = false;
    this.completedSegments = [];
    this.currentPartial = "";
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.connectionTimeout = null;
    this.closeResolve = null;
    this.isDisconnecting = false;
    this.audioBytesSent = 0;
    this.model = "gpt-4o-mini-transcribe";
  }

  getFullTranscript() {
    return this.completedSegments.join(" ");
  }

  async connect(options = {}) {
    const { apiKey, model } = options;
    if (!apiKey) throw new Error("OpenAI API key is required");

    if (this.isConnected) {
      debugLogger.debug("OpenAI Realtime already connected");
      return;
    }

    this.model = model || "gpt-4o-mini-transcribe";
    this.completedSegments = [];
    this.currentPartial = "";
    this.audioBytesSent = 0;

    const url = "wss://api.openai.com/v1/realtime?intent=transcription";
    debugLogger.debug("OpenAI Realtime connecting", { model: this.model });

    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.connectionTimeout = setTimeout(() => {
        this.cleanup();
        reject(new Error("OpenAI Realtime connection timeout"));
      }, WEBSOCKET_TIMEOUT_MS);

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "OpenAI-Beta": "realtime=v1",
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
        if (this.closeResolve) {
          this.closeResolve({ text: this.getFullTranscript() });
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
        case "transcription_session.created":
        case "transcription_session.updated": {
          if (this.pendingResolve) {
            this.isConnected = true;
            clearTimeout(this.connectionTimeout);
            debugLogger.debug("OpenAI Realtime session ready", {
              type: event.type,
              model: this.model,
            });
            this.pendingResolve();
            this.pendingResolve = null;
            this.pendingReject = null;
          }
          break;
        }

        case "conversation.item.input_audio_transcription.delta": {
          this.currentPartial += event.delta || "";
          this.onPartialTranscript?.(this.currentPartial);
          break;
        }

        case "conversation.item.input_audio_transcription.completed": {
          const transcript = (event.transcript || "").trim();
          if (transcript) {
            this.completedSegments.push(transcript);
          }
          this.currentPartial = "";
          const fullText = this.getFullTranscript();
          this.onFinalTranscript?.(fullText);
          debugLogger.debug("OpenAI Realtime turn completed", {
            turnText: transcript.slice(0, 100),
            totalLength: fullText.length,
            segments: this.completedSegments.length,
          });
          break;
        }

        case "input_audio_buffer.speech_started":
        case "input_audio_buffer.speech_stopped":
        case "input_audio_buffer.committed":
          break;

        case "error":
          debugLogger.error("OpenAI Realtime error event", {
            code: event.error?.code,
            message: event.error?.message,
          });
          this.onError?.(new Error(event.error?.message || "OpenAI Realtime error"));
          break;

        default:
          break;
      }
    } catch (err) {
      debugLogger.error("OpenAI Realtime message parse error", { error: err.message });
    }
  }

  sendAudio(pcmBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
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
    });

    if (!this.ws) return { text: this.getFullTranscript() };

    this.isDisconnecting = true;

    if (this.ws.readyState === WebSocket.OPEN) {
      let timeoutId;
      const result = await Promise.race([
        new Promise((resolve) => {
          this.closeResolve = resolve;
          this.ws.close();
        }),
        new Promise((resolve) => {
          timeoutId = setTimeout(() => {
            debugLogger.debug("OpenAI Realtime close timeout, using accumulated text");
            resolve({ text: this.getFullTranscript() });
          }, DISCONNECT_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timeoutId);
      this.closeResolve = null;
      this.cleanup();
      this.isDisconnecting = false;
      return result;
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
      } catch (err) {
        // ignore
      }
      this.ws = null;
    }

    this.isConnected = false;
    this.closeResolve = null;
  }
}

module.exports = OpenAIRealtimeStreaming;
