const { EventEmitter } = require("events");
const { ipcMain } = require("electron");
const debugLogger = require("./debugLogger");
const voiceWorker = require("./voiceWorkerClient");
const voiceModels = require("./voiceModels");
const { pcm16ToWav } = require("../utils/audioUtils");
const {
  VAD_SAMPLE_RATE,
  buildVoiceWorkerConfig,
  float32ToPcm16Buffer,
  resolveVoiceParakeetModel,
} = require("./voiceConversationConfig");
const { checkVoiceConversationReadiness } = require("./voiceConversationReadiness");
const { BYOK_API_KEYS } = require("../config/secretKeys");
const { createDownloadSignal } = require("./downloadUtils");

const WORKER_IDLE_STOP_MS = 5 * 60 * 1000;

// Local voice conversation: the renderer streams echo-cancelled 16 kHz mic frames in;
// the worker's VAD + Smart Turn cut turns, Parakeet transcribes them here, and Supertonic
// TTS audio streams back out. Gated in the renderer by the voiceConversationEnabled setting.
function registerVoiceConversationIpc({
  parakeetManager,
  onSessionActiveChange,
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

  // One way out of a session, whoever ends it: the renderer's stop, a worker crash,
  // or the renderer reloading or crashing. The last never reaches stop, and a session
  // left set would block dictation (onSessionActiveChange) until the app restarts.
  const endSession = () => {
    detachSessionRenderer?.();
    detachSessionRenderer = null;
    if (!session) return;
    session = null;
    onSessionActiveChange?.(false);
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
    session = { id: nextSessionId++, turns: Promise.resolve(), ...fields };
    onSessionActiveChange?.(true);
    return session;
  };

  const send = (payload) => {
    if (!sender || sender.isDestroyed()) return;
    sender.send("voice-conversation:event", payload);
  };

  voiceWorker.on("speech-start", () => {
    if (session) send({ type: "speech-start", at: Date.now() });
  });

  voiceWorker.on("speech-segment", ({ samples, endpoint }) => {
    const turnSession = session;
    if (!turnSession) return;
    const endedAt = Date.now();
    const speechMs = Math.round((samples.length / VAD_SAMPLE_RATE) * 1000);
    turnSession.turns = turnSession.turns.then(async () => {
      try {
        const wav = pcm16ToWav(float32ToPcm16Buffer(samples), VAD_SAMPLE_RATE);
        const result = await parakeetManager.transcribeLocalParakeet(wav, {
          model: turnSession.parakeetModel,
        });
        // "No speech" is a cough or a noise: an empty transcript, which resumes a paused answer.
        if (result?.success === false && result.code !== "NO_SPEECH_DETECTED") {
          throw new Error(result.error || "transcription failed");
        }
        // A session stopped (or replaced) while this decoded never hears about it.
        if (session !== turnSession) return;
        send({
          type: "transcript",
          text: result?.text?.trim() || "",
          speechMs,
          sttMs: Date.now() - endedAt,
          endedAt,
          endpoint: endpoint || null,
        });
      } catch (error) {
        debugLogger.error("voice conversation transcription failed", { error: error?.message });
        if (session === turnSession) {
          send({ type: "error", stage: "stt", message: error?.message || String(error) });
        }
      }
    });
  });

  voiceWorker.on("tts-audio", ({ utteranceId, chunkIndex, samples }) => {
    send({ type: "tts-audio", utteranceId, chunkIndex, samples, at: Date.now() });
  });

  voiceWorker.on("exit", ({ code }) => {
    configuredKey = null;
    if (!session) return;
    // Mic frames would otherwise go nowhere while the renderer keeps listening.
    endSession();
    // Exit code 0 is our own shutdown (app quit), not a crash worth a toast.
    if (code !== 0) {
      send({ type: "error", stage: "worker", message: `voice worker exited (${code})` });
    }
  });

  // End-to-end harness: the renderer reports each finished turn; the runner
  // (voiceHarnessRunner.js) waits on these to score scripted conversations.
  const harnessEnabled = process.env.OPENWHISPR_VOICE_HARNESS === "1";
  ipcMain.handle("voice-conversation:harness-enabled", () => harnessEnabled);
  // Local model id that answers voice turns instead of the Voice Assistant setting,
  // so harness comparisons neither depend on nor change the user's settings.
  ipcMain.handle("voice-conversation:brain-override", () =>
    harnessEnabled ? (process.env.OPENWHISPR_VOICE_HARNESS_BRAIN || "").trim() || null : null
  );
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
    sender = event.sender;
    if (!voiceModels.getVoiceModelStatus().ready) throw new Error("voice-models-missing");
    // A worker still shutting down would take the new session down with it when it exits.
    if (workerStopping) await workerStopping;
    const config = buildVoiceWorkerConfig({ modelPaths: voiceModels.getVoiceModelPaths() });
    const configKey = JSON.stringify([config.vad.sileroVad.model, config.smartTurn]);
    // The session begins before the worker loads, so dictation is already held off
    // while it does; a stop during the load ends it and wins.
    const starting = beginSession(event.sender, {
      parakeetModel: resolveVoiceParakeetModel(options.parakeetModel, (name) =>
        parakeetManager.isModelDownloaded(name)
      ),
      sampleRate: configuredSampleRate,
      brainModel: options.brainModel,
      harness: !!options.harness,
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
    // Warm Parakeet now: a cold server start (~3 s) would otherwise land on the first turn.
    parakeetManager.startServer(session.parakeetModel).catch((error) => {
      debugLogger.warn("voice conversation Parakeet warm-up failed", { error: error?.message });
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
      parakeetModel: session.parakeetModel,
    });
    return info;
  });

  // Starts the voice model if needed; on a running server this resets llama-server's
  // 5-minute idle timer. Called at session start (so the first turn skips the cold
  // start) and every minute after.
  ipcMain.handle("voice-conversation:keep-model-warm", async (_event, modelId) => {
    const modelManager = require("./modelManagerBridge").default;
    return { warmed: await modelManager.prewarmServer(modelId) };
  });

  ipcMain.on("voice-conversation:mic", (event, samples) => {
    // One Silero window per message; anything else isn't our session's mic.
    if (!session || event.sender !== sender) return;
    if (!(samples instanceof Float32Array) || samples.length > VAD_SAMPLE_RATE) return;
    voiceWorker.notify("vad-feed", { samples });
  });

  ipcMain.handle("voice-conversation:speak", (_event, request) =>
    voiceWorker.request("speak", request)
  );

  // A handful of short, fixed lines; anything else isn't what this is for.
  ipcMain.handle("voice-conversation:prepare-speech", (_event, texts) => {
    if (!session || !voiceWorker.running || !Array.isArray(texts)) return { queued: 0 };
    const lines = texts.filter((text) => typeof text === "string" && text.length <= 200);
    return voiceWorker.request("prepare-speech", { texts: lines.slice(0, 10) });
  });

  ipcMain.handle("voice-conversation:get-readiness", async (_event, request = {}) => {
    const speechModel = resolveVoiceParakeetModel(request.parakeetModel, (name) =>
      parakeetManager.isModelDownloaded(name)
    );
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
    return checkVoiceConversationReadiness({
      meetingRecording: Boolean(isMeetingRecording?.()),
      modelStatus: voiceModels.getVoiceModelStatus(),
      speechModelDownloaded: Boolean(speechModel && parakeetManager.isModelDownloaded(speechModel)),
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

  let modelDownload = null;
  ipcMain.handle("voice-conversation:download-models", async (event) => {
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

  ipcMain.handle("voice-conversation:cancel-download", () => {
    modelDownload?.abort();
    return { cancelled: Boolean(modelDownload) };
  });

  ipcMain.handle("voice-conversation:cancel-speech", (_event, { utteranceId }) =>
    voiceWorker.running ? voiceWorker.request("cancel", { utteranceId }) : { cancelled: true }
  );

  // A late stop from an earlier session (stop, then start again quickly) must not end
  // the new one, so it names the session it means.
  ipcMain.handle("voice-conversation:stop", (_event, sessionId) => {
    if (!session || (sessionId != null && sessionId !== session.id)) return { stopped: false };
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
