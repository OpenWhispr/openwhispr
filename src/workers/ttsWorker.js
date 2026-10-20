// Text-to-speech utility process. Keeps one sherpa-onnx OfflineTts voice
// loaded and streams synthesized audio back sentence by sentence, so playback
// can start as soon as the first sentence is ready. Runs in its own process
// (not the shared onnxWorker) because sherpa-onnx ships its own onnxruntime.dll
// and a native crash here must never take dictation down with it.
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildModelConfig,
  buildGenerationRequest,
  modelKey,
} = require("../helpers/readAloud/voiceEngine");

// Synthesis must never starve the UI (overlay clicks, dictation): run the
// whole worker below normal priority.
try {
  os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // Best effort; not fatal if the OS refuses.
}

let port = null;
let tts = null;
let loadedModelKey = null;
let loadedVoice = null;
let loadingPromise = null;
// Id of the request currently allowed to emit audio. Any other value makes
// the in-flight generation stop at its next sentence boundary.
let activeRequestId = null;

let logStream = null;
try {
  const logPath = process.env.OPENWHISPR_TTS_WORKER_LOG;
  if (logPath) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    logStream = fs.createWriteStream(logPath, { flags: "a" });
  }
} catch {
  logStream = null;
}

// Never log the text being read, only its size.
function log(level, message, extra) {
  if (!logStream) return;
  try {
    logStream.write(
      JSON.stringify({ ts: new Date().toISOString(), level, pid: process.pid, message, ...extra }) +
        "\n"
    );
  } catch {
    // Best-effort logging.
  }
}

function send(message, transfer) {
  try {
    port?.postMessage(message, transfer || []);
  } catch (err) {
    log("warn", "postMessage failed", { error: err.message });
  }
}

async function loadVoice(voice, voiceDir, numThreads) {
  if (tts && loadedModelKey === modelKey(voice, voiceDir)) {
    // Voices sharing an archive and a language (Kokoro speakers) share the
    // loaded model; only the speaker id sent per request changes.
    loadedVoice = voice;
    return;
  }
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    const sherpa = require("sherpa-onnx-node");
    const started = Date.now();
    const config = buildModelConfig(voice, voiceDir, numThreads);
    try {
      tts = await sherpa.OfflineTts.createAsync(config);
    } catch (err) {
      // Seen once right after switching voices; a second attempt succeeds.
      log("warn", "voice load failed, retrying", { voiceDir, error: err.message });
      await new Promise((resolve) => setTimeout(resolve, 500));
      tts = await sherpa.OfflineTts.createAsync(config);
    }
    loadedModelKey = modelKey(voice, voiceDir);
    loadedVoice = voice;
    // Warm-up so the first real request doesn't pay graph initialization.
    await tts.generateAsync(buildGenerationRequest(voice, "OK.", 1.0));
    log("info", "voice loaded", { voiceDir, engine: voice?.engine, ms: Date.now() - started });
  })();
  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

// One generation at a time on the native handle: a new request cancels the
// running one (it stops at its next sentence) and waits for it to unwind.
let currentGeneration = Promise.resolve();

function speak(payload) {
  activeRequestId = payload.requestId;
  const run = currentGeneration.then(() => runSpeak(payload));
  currentGeneration = run.catch(() => {});
  return run;
}

// Sentences arrive pre-split by main so every chunk carries its index and
// playback can restart from the sentence being heard (speed changes).
async function runSpeak({ requestId, sentences, startIndex = 0, speed }) {
  const started = Date.now();
  let chunks = 0;
  try {
    for (let index = startIndex; index < sentences.length; index += 1) {
      if (activeRequestId !== requestId) break;
      const audio = await tts.generateAsync(
        buildGenerationRequest(loadedVoice, sentences[index], speed || 1.0)
      );
      if (activeRequestId !== requestId) break;
      chunks += 1;
      if (chunks === 1) log("info", "first chunk", { ms: Date.now() - started });
      send({
        type: "chunk",
        requestId,
        index,
        sampleRate: audio.sampleRate || tts.sampleRate,
        samples: new Float32Array(audio.samples),
      });
    }
  } finally {
    const cancelled = activeRequestId !== requestId;
    if (!cancelled) activeRequestId = null;
    log("info", "speak finished", {
      sentences: sentences.length,
      startIndex,
      chunks,
      ms: Date.now() - started,
      cancelled,
    });
    send({ type: "done", requestId, cancelled });
  }
}

async function handle(msg) {
  const { id, method, payload } = msg;
  try {
    switch (method) {
      case "load":
        await loadVoice(payload.voice, payload.voiceDir, payload.numThreads || 2);
        send({ id, result: { sampleRate: tts.sampleRate } });
        return;
      case "speak":
        if (!tts) throw new Error("voice not loaded");
        send({ id, result: { accepted: true } });
        await speak(payload);
        return;
      case "cancel":
        activeRequestId = null;
        send({ id, result: { ok: true } });
        return;
      case "shutdown":
        send({ id, result: { ok: true } });
        setTimeout(() => process.exit(0), 10);
        return;
      default:
        throw new Error(`unknown method: ${method}`);
    }
  } catch (err) {
    log("error", "request failed", { method, error: err.message });
    send({ id, error: { message: err.message } });
  }
}

process.parentPort.once("message", (event) => {
  port = event.ports[0];
  port.on("message", (e) => {
    handle(e.data);
  });
  port.start();
  log("info", "tts worker ready");
});
