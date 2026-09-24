const path = require("path");
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
  resolveSpikeParakeetModel,
} = require("./voiceSpikeConfig");

// Local voice-conversation spike: dev-only, enabled with OPENWHISPR_VOICE_SPIKE=1.
// The renderer streams echo-cancelled 16 kHz mic frames in; the worker's VAD
// cuts turns, Parakeet transcribes them here, and TTS audio streams back out.
function registerVoiceSpikeIpc({ parakeetManager, getMeetingDetectionEngine }) {
  let sender = null;
  let session = null;

  // A hands-free session holds the mic open; treat it like a dictation recording
  // so meeting detection doesn't prompt "meeting detected" about our own session.
  const setRecording = (active) => {
    try {
      getMeetingDetectionEngine?.()?.setUserRecording(active);
    } catch (error) {
      debugLogger.warn("voice spike could not update meeting detection", { error: error?.message });
    }
  };
  let configuredKey = null;
  let configuredSampleRate = null;
  let configuredSmartTurn = false;
  const spikeEvents = new EventEmitter();

  const send = (payload, transfer) => {
    if (!sender || sender.isDestroyed()) return;
    sender.send("voice-spike:event", payload, transfer);
  };

  voiceWorker.on("speech-start", () => {
    if (session) send({ type: "speech-start", at: Date.now() });
  });

  voiceWorker.on("speech-segment", async ({ samples, endpoint }) => {
    if (!session) return;
    const endedAt = Date.now();
    const speechMs = Math.round((samples.length / VAD_SAMPLE_RATE) * 1000);
    try {
      const wav = pcm16ToWav(float32ToPcm16Buffer(samples), VAD_SAMPLE_RATE);
      const result = await parakeetManager.transcribeLocalParakeet(wav, {
        model: session.parakeetModel,
        language: session.language,
      });
      send({
        type: "transcript",
        text: result?.text?.trim() || "",
        speechMs,
        sttMs: Date.now() - endedAt,
        endedAt,
        endpoint: endpoint || null,
      });
    } catch (error) {
      debugLogger.error("voice spike transcription failed", { error: error?.message });
      send({ type: "error", stage: "stt", message: error?.message || String(error) });
    }
  });

  voiceWorker.on("tts-audio", ({ utteranceId, chunkIndex, samples }) => {
    send({ type: "tts-audio", utteranceId, chunkIndex, samples, at: Date.now() });
  });

  voiceWorker.on("exit", ({ code }) => {
    configuredKey = null;
    if (session) send({ type: "error", stage: "worker", message: `voice worker exited (${code})` });
  });

  ipcMain.handle("voice-spike:enabled", () => process.env.OPENWHISPR_VOICE_SPIKE === "1");

  // End-to-end harness: the renderer reports each finished turn; the runner
  // (voiceHarnessRunner.js) waits on these to score scripted conversations.
  const harnessEnabled =
    process.env.OPENWHISPR_VOICE_SPIKE === "1" && process.env.OPENWHISPR_VOICE_SPIKE_HARNESS === "1";
  ipcMain.handle("voice-spike:harness-enabled", () => harnessEnabled);
  // Local model id that answers voice turns instead of the Voice Assistant setting,
  // so harness comparisons neither depend on nor change the user's settings.
  ipcMain.handle(
    "voice-spike:brain-override",
    () => (process.env.OPENWHISPR_VOICE_SPIKE_BRAIN || "").trim() || null
  );
  ipcMain.on("voice-spike:turn-report", (_event, report) => spikeEvents.emit("turn-report", report));
  ipcMain.on("voice-spike:turn-event", (_event, turnEvent) => spikeEvents.emit("turn-event", turnEvent));
  if (harnessEnabled) {
    require("./voiceHarnessRunner")
      .runVoiceHarness({
        voiceWorker,
        spikeEvents,
        getSession: () => session,
        sendToRenderer: (channel) => {
          if (sender && !sender.isDestroyed()) sender.send(channel);
        },
      })
      .catch((error) => debugLogger.error("voice harness failed", { error: error?.message }));
  }

  ipcMain.handle("voice-spike:start", async (event, options = {}) => {
    sender = event.sender;
    if (!voiceModels.getVoiceModelStatus().ready) throw new Error("voice-models-missing");
    const config = buildVoiceWorkerConfig({ modelPaths: voiceModels.getVoiceModelPaths() });
    const configKey = JSON.stringify([config.vad.sileroVad.model, config.smartTurn]);
    let loadMs = 0;
    let sampleRate = configuredSampleRate;
    if (configuredKey !== configKey || !voiceWorker.running) {
      const result = await voiceWorker.request("configure", config);
      configuredKey = configKey;
      configuredSmartTurn = result.smartTurn;
      loadMs = result.loadMs;
      sampleRate = result.sampleRate;
      configuredSampleRate = result.sampleRate;
    } else {
      voiceWorker.notify("vad-reset", {});
    }
    setRecording(true);
    session = {
      parakeetModel: resolveSpikeParakeetModel(options.parakeetModel, (name) =>
        parakeetManager.isModelDownloaded(name)
      ),
      language: options.language,
      sampleRate,
      brainModel: options.brainModel,
      harness: !!options.harness,
    };
    spikeEvents.emit("session-started", session);
    // Warm Parakeet now: a cold server start (~3 s) would otherwise land on the first turn.
    parakeetManager.startServer(session.parakeetModel, session.language).catch((error) => {
      debugLogger.warn("voice spike Parakeet warm-up failed", { error: error?.message });
    });
    debugLogger.info("voice spike started", {
      smartTurn: configuredSmartTurn,
      minSilenceMs: Math.round(config.vad.sileroVad.minSilenceDuration * 1000),
      maxSilenceMs: config.smartTurn?.maxSilenceMs ?? null,
      loadMs,
      sampleRate,
      parakeetModel: session.parakeetModel,
    });
    return { sampleRate, loadMs, smartTurn: configuredSmartTurn };
  });

  // Starts the voice model if needed and resets llama-server's 5-minute idle
  // timer, which a plain start() on a running server does not do. Called at
  // session start (so the first turn skips the cold start) and every minute after.
  ipcMain.handle("voice-spike:keep-model-warm", async (_event, modelId) => {
    try {
      const modelManager = require("./modelManagerBridge").default;
      modelManager.ensureInitialized();
      const modelInfo = modelManager.findModelById(modelId);
      if (!modelInfo) return { warmed: false, reason: `unknown model ${modelId}` };
      const modelPath = path.join(modelManager.modelsDir, modelInfo.model.fileName);
      await modelManager.serverManager.start(modelPath, await modelManager.serverStartOptions(modelInfo));
      modelManager.currentServerModelId = modelId;
      modelManager.serverManager.resetIdleTimer();
      return { warmed: true };
    } catch (error) {
      debugLogger.warn("voice spike model warm-up failed", { error: error?.message });
      return { warmed: false, reason: error?.message };
    }
  });

  ipcMain.on("voice-spike:mic", (_event, samples) => {
    if (session) voiceWorker.notify("vad-feed", { samples });
  });

  ipcMain.handle("voice-spike:speak", (_event, request) => voiceWorker.request("speak", request));

  ipcMain.handle("voice-spike:cancel-speech", (_event, { utteranceId }) =>
    voiceWorker.running ? voiceWorker.request("cancel", { utteranceId }) : { cancelled: true }
  );

  ipcMain.handle("voice-spike:stop", () => {
    if (session) setRecording(false);
    session = null;
    voiceWorker.notify("vad-reset", {});
    return { stopped: true };
  });
}

module.exports = { registerVoiceSpikeIpc };
