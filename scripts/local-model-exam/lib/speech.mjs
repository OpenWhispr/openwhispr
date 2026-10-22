// Drives the app's own speech engines with the options its IPC handlers pass
// (src/helpers/ipcHandlers.js "transcribe-local-whisper", "transcribe-local-parakeet",
// "start-dictation-preview"). Call installElectronStub() before using this module.
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "./electron.mjs";
import { SAMPLE_RATE, pcmToWav } from "./audio.mjs";
import { baseLanguage } from "./score.mjs";

const require = createRequire(import.meta.url);
const src = (relative) => path.join(REPO_ROOT, "src", relative);

let managers = null;

function loadManagers() {
  if (managers) return managers;
  const WhisperManager = require(src("helpers/whisper.js"));
  const ParakeetManager = require(src("helpers/parakeet.js"));
  const { getModelRuntime } = require(src("helpers/parakeetModelInfo.js"));
  const { DEFAULT_WHISPER_VAD_CONFIG } = require(src("helpers/whisperVadConfig.js"));
  const registry = require(src("models/modelRegistryData.json"));
  managers = {
    whisper: new WhisperManager(),
    parakeet: new ParakeetManager(),
    getModelRuntime,
    vadConfig: { ...DEFAULT_WHISPER_VAD_CONFIG },
    registry,
  };
  return managers;
}

let gate = null;
async function loadSpeechGate() {
  gate ??= await import(pathToFileURL(src("helpers/localSpeechGate.js")).href);
  return gate;
}

// The renderer gate that runs before every local dictation (audioManager.js
// processAudio): pure silence is skipped for every engine, weak speech only
// for Whisper. Back-to-back 2048-sample windows stand in for the 2048-sample
// analyser frames the app reads every 100 ms while recording.
export async function speechGateSkips(pcm, engineKind) {
  const g = await loadSpeechGate();
  const state = g.createLocalSpeechGateState();
  const window = 2048 * 2;
  for (let offset = 0; offset < pcm.length; offset += window) {
    const slice = pcm.subarray(offset, Math.min(pcm.length, offset + window));
    const copy = new Uint8Array(slice).buffer;
    g.recordPcm16SpeechWindow(state, copy);
  }
  const decision = g.getLocalSpeechGateDecision(state);
  return decision.skip && (decision.reason === "silence" || engineKind === "whisper");
}

function speechModelKind(modelId) {
  const { registry, getModelRuntime } = loadManagers();
  if (registry.whisperModels[modelId]) return "whisper";
  if (!registry.parakeetModels[modelId]) throw new Error(`Unknown speech model: ${modelId}`);
  return getModelRuntime(modelId) === "online" ? "sherpa-online" : "sherpa-offline";
}

// Whisper takes every language; the NVIDIA models list theirs in the registry.
export function speechModelSupports(modelId, language) {
  const entry = loadManagers().registry.parakeetModels[modelId];
  return !entry || (entry.supportedLanguages || []).includes(baseLanguage(language));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export function createSpeechEngine(modelId) {
  const m = loadManagers();
  const kind = speechModelKind(modelId);

  // The app's own model download (registry URL, size check, unpacking); a no-op
  // when the model is already in the cache.
  const download = () =>
    kind === "whisper"
      ? m.whisper.downloadWhisperModel(modelId)
      : m.parakeet.downloadParakeetModel(modelId);
  const cancelDownload = () => (kind === "whisper" ? m.whisper : m.parakeet).cancelDownload();

  // One whole-recording decode, as after the dictation key is released.
  async function transcribe(pcm, { language = null, vad = false } = {}) {
    const wav = pcmToWav(pcm);
    const started = performance.now();
    try {
      const result =
        kind === "whisper"
          ? await m.whisper.transcribeLocalWhisper(wav, {
              model: modelId,
              language,
              vadEnabled: vad,
              vadConfig: m.vadConfig,
            })
          : await m.parakeet.transcribeLocalParakeet(wav, { model: modelId, language });
      const ms = performance.now() - started;
      if (result?.success)
        return { ok: true, text: result.text || "", ms, warning: result.warning || null };
      if (result?.code === "NO_SPEECH_DETECTED") return { ok: true, text: "", ms };
      return { ok: false, text: "", ms, error: result?.error || result?.message || "failed" };
    } catch (error) {
      return { ok: false, text: "", ms: performance.now() - started, error: error.message };
    }
  }

  // The online path: audio streams while the user talks (preview window shown
  // or not), and stream.finish() after release supplies the dictation's text.
  async function stream(pcm, { realtime = true, frameMs = 100 } = {}) {
    if (kind !== "sherpa-online") throw new Error(`${modelId} has no online runtime`);
    const frameBytes = Math.round((SAMPLE_RATE * frameMs) / 1000) * 2;
    const updates = [];
    let streamError = null;
    const t0 = performance.now();
    let s;
    try {
      s = await m.parakeet.createOnlineStream(modelId, {
        onUpdate: (text) => updates.push({ atMs: performance.now() - t0, text }),
        onError: (error) => {
          streamError = error;
        },
      });
    } catch (error) {
      return { ok: false, text: "", error: error.message, updates, waitMs: null };
    }
    const readyMs = performance.now() - t0;
    for (let offset = 0, frame = 0; offset < pcm.length; offset += frameBytes, frame++) {
      if (realtime) await sleep(t0 + frame * frameMs - performance.now());
      s.sendPcm16(pcm.subarray(offset, Math.min(pcm.length, offset + frameBytes)));
    }
    if (realtime) await sleep(t0 + (pcm.length / 2 / SAMPLE_RATE) * 1000 - performance.now());
    const released = performance.now();
    const result = await s.finish().catch((error) => {
      streamError = error;
      return null;
    });
    const waitMs = performance.now() - released;
    if (!result)
      return {
        ok: false,
        text: "",
        error: streamError?.message || "stream failed",
        updates,
        waitMs,
        readyMs,
      };
    return {
      ok: !streamError,
      text: result.text || "",
      truncated: !!result.truncated,
      updates,
      waitMs,
      readyMs,
      error: streamError?.message || null,
    };
  }

  // The offline preview path: every 1.5 s the audio that arrived since the last
  // tick is decoded on its own and appended to the preview, skipped while a
  // decode is still running and when the chunk is near silent (rms < 0.002).
  async function preview(pcm, { language = null, vad = false, intervalMs = 1500 } = {}) {
    if (kind === "sherpa-online") throw new Error("online models preview through stream()");
    const t0 = performance.now();
    const totalMs = (pcm.length / 2 / SAMPLE_RATE) * 1000;
    let consumedBytes = 0;
    let busy = false;
    const chunks = [];
    const inFlight = [];
    for (let tick = intervalMs; tick <= totalMs + intervalMs; tick += intervalMs) {
      await sleep(t0 + tick - performance.now());
      if (busy) continue;
      const availableBytes = Math.min(
        pcm.length,
        Math.floor((Math.min(tick, totalMs) / 1000) * SAMPLE_RATE) * 2
      );
      if (availableBytes <= consumedBytes) continue;
      const chunk = pcm.subarray(consumedBytes, availableBytes);
      const chunkEndMs = (availableBytes / 2 / SAMPLE_RATE) * 1000;
      consumedBytes = availableBytes;
      let sumSq = 0;
      for (let i = 0; i < chunk.length; i += 2) {
        const v = chunk.readInt16LE(i) / 0x7fff;
        sumSq += v * v;
      }
      if (Math.sqrt(sumSq / (chunk.length / 2)) < 0.002) continue;
      busy = true;
      const job = transcribe(chunk, { language, vad }).then((r) => {
        chunks.push({
          audioEndMs: chunkEndMs,
          shownAtMs: performance.now() - t0,
          decodeMs: r.ms,
          text: r.text,
          ok: r.ok,
        });
        busy = false;
      });
      inFlight.push(job);
    }
    await Promise.all(inFlight);
    return {
      chunks,
      text: chunks
        .map((c) => c.text.trim())
        .filter(Boolean)
        .join(" "),
    };
  }

  async function unload() {
    if (kind === "whisper") await m.whisper.stopServer().catch(() => {});
    else await m.parakeet.stopServer().catch(() => {});
  }

  return { id: modelId, kind, download, cancelDownload, transcribe, stream, preview, unload };
}

export async function stopAllSpeechEngines() {
  if (!managers) return;
  await managers.whisper.stopServer().catch(() => {});
  await managers.parakeet.stopServer().catch(() => {});
}
