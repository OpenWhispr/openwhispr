const { EventEmitter } = require("events");
const { ipcMain } = require("electron");
const debugLogger = require("./debugLogger");
const voiceWorker = require("./voiceWorkerClient");
const voiceModels = require("./voiceModels");
const { pcm16ToWav } = require("../utils/audioUtils");
const {
  VAD_SAMPLE_RATE,
  CALL_LANGUAGES,
  buildVoiceWorkerConfig,
  float32ToPcm16Buffer,
  resolveCallRecognizer,
  toSpeechProfile,
} = require("./voiceConversationConfig");
const { checkVoiceConversationReadiness } = require("./voiceConversationReadiness");
const { BYOK_API_KEYS } = require("../config/secretKeys");
const { createDownloadSignal } = require("./downloadUtils");
const { registryData, listRunnableLocalModels } = require("../models/registryData.js");

const WORKER_IDLE_STOP_MS = 5 * 60 * 1000;
// Whisper for a language no Parakeet model here knows: the larger, the better it hears.
const WHISPER_PREFERENCE = [
  "turbo",
  "turbo-q5",
  "large",
  "large-q5",
  "medium",
  "small",
  "base",
  "tiny",
];

const isNoSpeech = (result) =>
  result?.success === false &&
  (result.code === "NO_SPEECH_DETECTED" || result.message === "No audio detected");

// A voice call: the agent window streams echo-cancelled 16 kHz mic frames in; the
// worker's VAD + Smart Turn cut turns, a local speech model transcribes them here,
// and Supertonic TTS audio streams back out.
function registerVoiceConversationIpc({
  parakeetManager,
  whisperManager,
  isFromCallWindow,
  warmSemanticSearch,
  isMeetingRecording,
}) {
  let sender = null;
  let session = null;
  let nextSessionId = 1;
  let detachSessionRenderer = null;
  let workerIdleTimer = null;
  let workerStopping = null;
  let configuredKey = null;
  let configuredSampleRate = null;
  let configuredSmartTurn = false;
  const conversationEvents = new EventEmitter();

  // A model the organization's policy refuses would refuse every turn; `onRefused`
  // hears its refusal code, so readiness can tell it from a missing model.
  const recognizerFor = ({ language, preferredParakeet, preferredWhisper } = {}, onRefused) => {
    const usable = (manager, name) => {
      if (!manager.isModelDownloaded(name)) return false;
      const refusal = manager.localModelPolicy?.failure("transcription", name);
      if (refusal) onRefused?.(refusal.code);
      return !refusal;
    };
    return resolveCallRecognizer(language, {
      parakeetModels: listRunnableLocalModels("parakeetModels").map(([id, model]) => ({
        id,
        supportedLanguages: model.supportedLanguages,
        modelType: model.modelType,
      })),
      preferredParakeet,
      isParakeetDownloaded: (name) => usable(parakeetManager, name),
      whisperModels: [
        preferredWhisper,
        ...WHISPER_PREFERENCE.filter((name) => Object.hasOwn(registryData.whisperModels, name)),
      ].filter(Boolean),
      isWhisperDownloaded: (name) => usable(whisperManager, name),
    });
  };

  // One way out of a session, whoever ends it: the renderer's stop, a worker crash,
  // a meeting, or the renderer reloading or crashing. The last never reaches stop.
  const endSession = () => {
    detachSessionRenderer?.();
    detachSessionRenderer = null;
    if (!session) return;
    session = null;
    // The worker holds the VAD, Smart Turn and Supertonic TTS in memory; like the ONNX
    // worker, it goes once idle, and the next session respawns and reconfigures it.
    clearTimeout(workerIdleTimer);
    workerIdleTimer = setTimeout(() => {
      if (session) return;
      workerStopping = voiceWorker.stop().finally(() => {
        workerStopping = null;
      });
    }, WORKER_IDLE_STOP_MS);
    workerIdleTimer.unref?.();
  };

  const beginSession = (webContents, fields) => {
    detachSessionRenderer?.();
    clearTimeout(workerIdleTimer);
    const rendererEvents = ["did-navigate", "render-process-gone", "destroyed"];
    for (const name of rendererEvents) webContents.once(name, endSession);
    detachSessionRenderer = () => {
      for (const name of rendererEvents) webContents.removeListener(name, endSession);
    };
    // Turns decode one at a time, so they reach the renderer in the order they were spoken.
    session = { id: nextSessionId++, turns: Promise.resolve(), inputPaused: false, ...fields };
    return session;
  };

  const send = (payload) => {
    if (!sender || sender.isDestroyed()) return;
    sender.send("voice-conversation:event", payload);
  };

  const transcribe = async (wav, recognizer) => {
    const result =
      recognizer.engine === "whisper"
        ? await whisperManager.transcribeLocalWhisper(wav, {
            model: recognizer.model,
            language: recognizer.language,
          })
        : await parakeetManager.transcribeLocalParakeet(wav, {
            model: recognizer.model,
            ...(recognizer.language ? { language: recognizer.language } : {}),
          });
    // "No speech" is a cough or a noise: an empty transcript, which resumes a paused answer.
    if (isNoSpeech(result)) return "";
    if (result?.success === false) {
      throw new Error(result.error || result.message || "transcription failed");
    }
    return result?.text?.trim() || "";
  };

  voiceWorker.on("speech-start", () => {
    if (session && !session.inputPaused) {
      send({ type: "speech-start", sessionId: session.id, at: Date.now() });
    }
  });

  voiceWorker.on("speech-segment", ({ samples, endpoint }) => {
    const turnSession = session;
    if (!turnSession || turnSession.inputPaused) return;
    const endedAt = Date.now();
    const speechMs = Math.round((samples.length / VAD_SAMPLE_RATE) * 1000);
    turnSession.turns = turnSession.turns.then(async () => {
      try {
        const wav = pcm16ToWav(float32ToPcm16Buffer(samples), VAD_SAMPLE_RATE);
        const text = await transcribe(wav, turnSession.recognizer);
        // A session stopped (or replaced) while this decoded never hears about it.
        if (session !== turnSession) return;
        send({
          type: "transcript",
          sessionId: turnSession.id,
          text,
          speechMs,
          sttMs: Date.now() - endedAt,
          endedAt,
          endpoint: endpoint || null,
        });
      } catch (error) {
        debugLogger.error("voice conversation transcription failed", { error: error?.message });
        if (session === turnSession) {
          send({
            type: "error",
            stage: "stt",
            sessionId: turnSession.id,
            message: error?.message || String(error),
          });
        }
      }
    });
  });

  voiceWorker.on("tts-audio", ({ utteranceId, samples }) => {
    send({ type: "tts-audio", utteranceId, samples });
  });

  voiceWorker.on("exit", ({ code }) => {
    configuredKey = null;
    if (!session) return;
    // Mic frames would otherwise go nowhere while the renderer keeps listening.
    endSession();
    // Exit code 0 is our own shutdown (app quit), not a crash worth a notice.
    if (code !== 0) {
      send({ type: "error", stage: "worker", message: `voice worker exited (${code})` });
    }
  });

  // End-to-end harness: the renderer reports each finished turn; the runner
  // (voiceHarnessRunner.js) waits on these to score scripted conversations.
  const harnessEnabled = process.env.OPENWHISPR_VOICE_HARNESS === "1";
  ipcMain.handle("voice-conversation:harness-enabled", () => harnessEnabled);
  ipcMain.on("voice-conversation:turn-report", (_event, report) =>
    conversationEvents.emit("turn-report", report)
  );
  ipcMain.on("voice-conversation:turn-event", (_event, turnEvent) =>
    conversationEvents.emit("turn-event", turnEvent)
  );
  if (harnessEnabled) {
    require("./voiceHarnessRunner")
      .runVoiceHarness({
        voiceWorker,
        conversationEvents,
        getSession: () => session,
        sendToRenderer: (channel) => {
          if (sender && !sender.isDestroyed()) sender.send(channel);
        },
      })
      .catch((error) => debugLogger.error("voice harness failed", { error: error?.message }));
  }

  ipcMain.handle("voice-conversation:start", async (event, options = {}) => {
    if (!isFromCallWindow(event)) throw new Error("not-call-window");
    if (!voiceModels.getVoiceModelStatus().ready) throw new Error("voice-models-missing");
    const recognizer = recognizerFor(options);
    if (!recognizer) throw new Error("speech-model-missing");
    sender = event.sender;
    // A worker still shutting down would take the new session down with it when it exits.
    if (workerStopping) await workerStopping;
    const config = buildVoiceWorkerConfig({ modelPaths: voiceModels.getVoiceModelPaths() });
    const configKey = JSON.stringify([config.vad.sileroVad.model, config.smartTurn]);
    // The session begins before the worker loads; a stop during the load ends it and wins.
    const starting = beginSession(event.sender, {
      recognizer,
      sampleRate: configuredSampleRate,
      // Named in the harness report.
      brainModel: typeof options.brainModel === "string" ? options.brainModel : null,
    });
    const sessionId = starting.id;
    let loadMs = 0;
    if (configuredKey !== configKey || !voiceWorker.running) {
      let result;
      try {
        result = await voiceWorker.request("configure", config);
      } catch (error) {
        if (session === starting) endSession();
        throw error;
      }
      configuredKey = configKey;
      configuredSmartTurn = result.smartTurn;
      loadMs = result.loadMs;
      starting.sampleRate = result.sampleRate;
      configuredSampleRate = result.sampleRate;
    } else {
      voiceWorker.notify("vad-reset", {});
    }
    const { sampleRate } = starting;
    const info = { sessionId, sampleRate, loadMs, smartTurn: configuredSmartTurn };
    if (session !== starting) return info;
    conversationEvents.emit("session-started", session);
    // Warm the speech model now: a cold server start (~3 s) would otherwise land on the first turn.
    const warm =
      recognizer.engine === "whisper"
        ? whisperManager.startServer(recognizer.model)
        : parakeetManager.startServer(recognizer.model, recognizer.language);
    Promise.resolve(warm).catch((error) => {
      debugLogger.warn("voice conversation speech model warm-up failed", { error: error?.message });
    });
    // Turns look up notes by meaning; a cold index would answer the first ones by keyword.
    Promise.resolve(warmSemanticSearch?.()).catch((error) => {
      debugLogger.warn("voice conversation semantic search warm-up failed", {
        error: error?.message,
      });
    });
    debugLogger.info("voice conversation started", {
      smartTurn: configuredSmartTurn,
      minSilenceMs: Math.round(config.vad.sileroVad.minSilenceDuration * 1000),
      maxSilenceMs: config.smartTurn?.maxSilenceMs ?? null,
      loadMs,
      sampleRate,
      recognizer,
    });
    return info;
  });

  // Starts the voice model if needed; on a running server this resets llama-server's
  // 5-minute idle timer. Called at session start (so the first turn skips the cold
  // start) and every minute after.
  ipcMain.handle("voice-conversation:keep-model-warm", async (event, modelId) => {
    if (!isFromCallWindow(event)) return { warmed: false };
    const modelManager = require("./modelManagerBridge").default;
    return { warmed: await modelManager.prewarmServer(modelId) };
  });

  ipcMain.on("voice-conversation:mic", (event, samples) => {
    // One Silero window per message; anything else isn't our session's mic.
    if (!session || session.inputPaused || event.sender !== sender) return;
    if (!(samples instanceof Float32Array) || samples.length > VAD_SAMPLE_RATE) return;
    voiceWorker.notify("vad-feed", { samples });
  });

  // Microphone off, or a card asking for a secret: nothing heard meanwhile becomes a
  // turn, and speech cut off by the pause doesn't commit later.
  ipcMain.handle("voice-conversation:pause-input", (event, sessionId, paused) => {
    if (!session || event.sender !== sender || sessionId !== session.id) return false;
    session.inputPaused = paused === true;
    voiceWorker.notify("vad-reset", {});
    return true;
  });

  // A reply paused for the user's speech: a word or two ends the turn at its first pause,
  // so a backchannel or a stop word doesn't wait out the end-of-turn silence.
  ipcMain.on("voice-conversation:hold-reply", (event, sessionId, held) => {
    if (!session || event.sender !== sender || sessionId !== session.id) return;
    voiceWorker.notify("reply-held", { held: held === true });
  });

  // The call's language changed: later turns are heard by a model that knows it.
  ipcMain.handle("voice-conversation:set-language", (event, sessionId, request = {}) => {
    if (!session || event.sender !== sender || sessionId !== session.id) return false;
    const recognizer = recognizerFor(request);
    if (!recognizer) return false;
    session.recognizer = recognizer;
    const warm =
      recognizer.engine === "whisper"
        ? whisperManager.startServer(recognizer.model)
        : parakeetManager.startServer(recognizer.model, recognizer.language);
    Promise.resolve(warm).catch((error) => {
      debugLogger.warn("voice conversation speech model warm-up failed", { error: error?.message });
    });
    debugLogger.info("voice conversation language changed", { recognizer });
    return true;
  });

  ipcMain.handle("voice-conversation:speak", (event, request = {}) => {
    if (!session || event.sender !== sender) return { cancelled: true };
    return voiceWorker.request("speak", {
      utteranceId: request.utteranceId,
      text: request.text,
      profile: toSpeechProfile(request.profile),
    });
  });

  // A handful of short, fixed lines; anything else isn't what this is for.
  ipcMain.handle("voice-conversation:prepare-speech", (event, request = {}) => {
    if (!session || event.sender !== sender || !voiceWorker.running) return { queued: 0 };
    if (!Array.isArray(request.texts)) return { queued: 0 };
    const lines = request.texts.filter((text) => typeof text === "string" && text.length <= 200);
    return voiceWorker.request("prepare-speech", {
      texts: lines.slice(0, 10),
      profile: toSpeechProfile(request.profile),
    });
  });

  ipcMain.handle("voice-conversation:get-readiness", async (event, request = {}) => {
    if (!isFromCallWindow(event)) return { ready: false, reason: "language-unsupported" };
    // The settled verdict, so readiness picks the model a turn will be allowed to use.
    await parakeetManager.localModelPolicy?.resolve().catch(() => {});
    const brain = request.brain || {};
    let brainDownloaded = false;
    if (brain.mode === "local" && brain.model) {
      const modelManager = require("./modelManagerBridge").default;
      modelManager.ensureInitialized();
      brainDownloaded = await modelManager.isModelDownloaded(brain.model).catch(() => false);
    }
    // The standard BYOK providers keep their key in the environment; custom and
    // enterprise providers have their own credentials, so they aren't checked here.
    const byokKey = BYOK_API_KEYS.find((entry) => entry.base === brain.provider);
    let refusal = null;
    const recognizer = recognizerFor(request, (code) => {
      refusal ??= code;
    });
    return checkVoiceConversationReadiness({
      meetingRecording: Boolean(isMeetingRecording?.()),
      modelStatus: voiceModels.getVoiceModelStatus(),
      recognizer,
      refusal,
      language: request.language,
      brain: {
        mode: brain.mode,
        model: brain.model,
        downloaded: brainDownloaded,
        signedIn: Boolean(brain.signedIn),
        keyMissing: brain.mode === "providers" && Boolean(byokKey) && !process.env[byokKey.env],
      },
    });
  });

  // Which call languages a downloaded speech model can hear now, for the language picker.
  ipcMain.handle("voice-conversation:languages", (event, request = {}) => {
    if (!isFromCallWindow(event)) return [];
    return CALL_LANGUAGES.map((language) => ({
      language,
      engine: recognizerFor({ ...request, language })?.engine ?? null,
    }));
  });

  let modelDownload = null;
  ipcMain.handle("voice-conversation:download-models", async (event) => {
    if (!isFromCallWindow(event)) throw new Error("not-call-window");
    if (modelDownload) return modelDownload.promise;
    // downloadFile takes this { aborted, onAbort } signal, not an AbortSignal.
    const { signal, abort } = createDownloadSignal();
    const promise = voiceModels
      .downloadVoiceModels({
        signal,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed())
            event.sender.send("voice-conversation:download-progress", progress);
        },
      })
      .finally(() => {
        modelDownload = null;
      });
    modelDownload = { abort, promise };
    return promise;
  });

  ipcMain.handle("voice-conversation:cancel-download", (event) => {
    if (!isFromCallWindow(event)) return { cancelled: false };
    modelDownload?.abort();
    return { cancelled: Boolean(modelDownload) };
  });

  ipcMain.handle("voice-conversation:cancel-speech", (event, { utteranceId } = {}) => {
    if (!isFromCallWindow(event)) return { cancelled: false };
    return voiceWorker.running
      ? voiceWorker.request("cancel", { utteranceId })
      : { cancelled: true };
  });

  // A late stop from an earlier session (stop, then start again quickly) must not end
  // the new one, so it names the session it means.
  ipcMain.handle("voice-conversation:stop", (event, sessionId) => {
    if (!session || event.sender !== sender) return { stopped: false };
    if (sessionId != null && sessionId !== session.id) return { stopped: false };
    endSession();
    voiceWorker.notify("vad-reset", {});
    return { stopped: true };
  });

  return {
    // A meeting recording takes the mic, and the assistant would answer the meeting.
    endSessionForMeeting() {
      if (!session) return;
      endSession();
      send({ type: "ended", reason: "meeting" });
    },
  };
}

module.exports = { registerVoiceConversationIpc };
