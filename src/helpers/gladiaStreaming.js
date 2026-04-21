const { GladiaClient } = require("@gladiaio/sdk");
const debugLogger = require("./debugLogger");
const packageJson = require("../../package.json");

const CONNECT_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 5000;

function buildSessionConfig(options = {}) {
  const lang = options.language && options.language !== "auto" ? options.language : null;
  const config = {
    model: "solaria-1",
    encoding: "wav/pcm",
    sample_rate: options.sampleRate || 16000,
    bit_depth: 16,
    channels: 1,
    endpointing: 0.3,
    maximum_duration_without_endpointing: 40,
    pre_processing: { speech_threshold: 0.75 },
    messages_config: { receive_partial_transcripts: true },
    custom_metadata: { openwhispr: packageJson.version },
  };
  if (lang) {
    config.language_config = { languages: [lang], code_switching: false };
  } else {
    config.language_config = { languages: [], code_switching: false };
  }
  const keyterms = (options.keyterms || []).filter(Boolean);
  if (keyterms.length > 0) {
    config.realtime_processing = {
      custom_vocabulary: true,
      custom_vocabulary_config: { vocabulary: keyterms.map(String) },
    };
  }
  return config;
}

class GladiaStreaming {
  constructor() {
    this.session = null;
    this.warmSession = null;
    this.isConnected = false;
    this.accumulatedText = "";
    this.finalSegments = [];
    this.completedSegments = [];
    this.onPartialTranscript = null;
    this.onFinalTranscript = null;
    this.onError = null;
    this.onSessionEnd = null;
  }

  _createSession(apiKey, options) {
    const client = new GladiaClient({ apiKey, httpHeaders: { "x-api-key": apiKey } });
    return client.liveV2().startSession(buildSessionConfig(options));
  }

  _attachHandlers(session) {
    session.on("message", (message) => {
      if (message.type !== "transcript") return;
      const text = message.data?.utterance?.text;
      if (!text) return;
      if (message.data.is_final) {
        const trimmed = text.trim();
        if (trimmed) {
          this.finalSegments.push(trimmed);
          this.completedSegments.push(trimmed);
          this.accumulatedText = this.finalSegments.join(" ");
          this.onFinalTranscript?.(this.accumulatedText, Date.now());
          debugLogger.debug("Gladia final transcript", { text: trimmed.slice(0, 100) });
        }
      } else {
        this.onPartialTranscript?.(text);
      }
    });

    session.on("error", (error) => {
      debugLogger.error("Gladia session error", { error: error?.message });
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    });

    session.on("ended", ({ code }) => {
      debugLogger.debug("Gladia session ended", { code });
      this.isConnected = false;
      this.onSessionEnd?.({});
    });
  }

  _waitForConnected(session) {
    return new Promise((resolve, reject) => {
      if (session.status === "connected") {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        session.endSession();
        reject(new Error("Gladia session connect timeout"));
      }, CONNECT_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timeout);
        session.off("connected", onConnected);
        session.off("error", onError);
        session.off("ended", onEnded);
      };
      const onConnected = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const onEnded = ({ code }) => {
        cleanup();
        reject(new Error(`Gladia session ended before connecting (code: ${code})`));
      };

      session.once("connected", onConnected);
      session.once("error", onError);
      session.once("ended", onEnded);
    });
  }

  async warmup(options = {}) {
    const { apiKey } = options;
    if (!apiKey) throw new Error("Gladia API key required for warmup");

    if (this.warmSession) {
      const s = this.warmSession.status;
      if (s === "connected" || s === "connecting" || s === "starting" || s === "started") {
        debugLogger.debug("Gladia warm session already in progress", { status: s });
        return;
      }
      this.warmSession.endSession();
      this.warmSession = null;
    }

    debugLogger.debug("Gladia warming up session");
    const session = this._createSession(apiKey, options);
    this.warmSession = session;

    try {
      await this._waitForConnected(session);
      debugLogger.debug("Gladia warm session connected", { sessionId: session.sessionId });
    } catch (err) {
      if (this.warmSession === session) this.warmSession = null;
      throw err;
    }
  }

  hasWarmConnection() {
    return this.warmSession !== null && this.warmSession.status === "connected";
  }

  async connect(options = {}) {
    const { apiKey } = options;
    if (!apiKey) throw new Error("Gladia API key required");

    if (this.isConnected) {
      debugLogger.debug("Gladia already connected");
      return;
    }

    this.accumulatedText = "";
    this.finalSegments = [];
    this.completedSegments = [];

    let session;
    const warmStatus = this.warmSession?.status;
    const reuseWarm =
      this.warmSession &&
      (warmStatus === "connected" ||
        warmStatus === "connecting" ||
        warmStatus === "starting" ||
        warmStatus === "started");

    if (reuseWarm) {
      debugLogger.debug("Gladia reusing warm session", { warmStatus });
      session = this.warmSession;
      this.warmSession = null;
    } else {
      if (this.warmSession) {
        this.warmSession.endSession();
        this.warmSession = null;
      }
      debugLogger.debug("Gladia cold-start session");
      session = this._createSession(apiKey, options);
    }

    this._attachHandlers(session);
    this.session = session;
    this.isConnected = true;
    debugLogger.debug("Gladia session active — audio buffered until WebSocket ready");
  }

  sendAudio(pcmBuffer) {
    if (!this.session || !this.isConnected) return false;
    this.session.sendAudio(pcmBuffer);
    return true;
  }

  finalize() {
    return true;
  }

  async disconnect(graceful = true) {
    const session = this.session;
    this.session = null;
    this.isConnected = false;

    if (!session) return { text: this.accumulatedText };

    const s = session.status;
    if (!graceful || s === "ending" || s === "ended") {
      session.endSession();
      const text = this.accumulatedText;
      this.accumulatedText = "";
      this.finalSegments = [];
      return { text };
    }

    const result = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        debugLogger.debug("Gladia stop timeout, using accumulated text");
        session.endSession();
        resolve({ text: this.accumulatedText });
      }, STOP_TIMEOUT_MS);

      session.once("ended", () => {
        clearTimeout(timeout);
        resolve({ text: this.accumulatedText });
      });

      session.stopRecording();
    });

    this.accumulatedText = "";
    this.finalSegments = [];
    return result;
  }

  cleanup() {
    if (this.session) {
      this.session.endSession();
      this.session = null;
    }
    this.isConnected = false;
    this.accumulatedText = "";
    this.finalSegments = [];
    this.completedSegments = [];
  }

  cleanupAll() {
    this.cleanup();
    if (this.warmSession) {
      this.warmSession.endSession();
      this.warmSession = null;
    }
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      sessionId: this.session?.sessionId ?? null,
      hasWarmConnection: this.hasWarmConnection(),
    };
  }
}

module.exports = GladiaStreaming;
