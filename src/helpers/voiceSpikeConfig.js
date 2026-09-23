const path = require("path");

const TTS_KINDS = ["kokoro", "pocket", "kitten"];
const VAD_SAMPLE_RATE = 16000;
const DEFAULT_SILENCE_MS = 500;
const MIN_SILENCE_MS = 150;
const MAX_SILENCE_MS = 2000;
const SMART_TURN_PAUSE_MS = 200;
const SMART_TURN_MAX_SILENCE_MS = 1200;

function resolveTtsKind(value) {
  const kind = String(value || "")
    .trim()
    .toLowerCase();
  return TTS_KINDS.includes(kind) ? kind : "kokoro";
}

function espeakModel(dir, fileName) {
  return {
    model: path.join(dir, fileName),
    voices: path.join(dir, "voices.bin"),
    tokens: path.join(dir, "tokens.txt"),
    dataDir: path.join(dir, "espeak-ng-data"),
  };
}

function ttsModelFor(kind, ttsRoot) {
  if (kind === "pocket") {
    const dir = path.join(ttsRoot, "sherpa-onnx-pocket-tts-int8-2026-01-26");
    return {
      model: {
        pocket: {
          lmFlow: path.join(dir, "lm_flow.int8.onnx"),
          lmMain: path.join(dir, "lm_main.int8.onnx"),
          encoder: path.join(dir, "encoder.onnx"),
          decoder: path.join(dir, "decoder.int8.onnx"),
          textConditioner: path.join(dir, "text_conditioner.onnx"),
          vocabJson: path.join(dir, "vocab.json"),
          tokenScoresJson: path.join(dir, "token_scores.json"),
        },
      },
      pocketVoiceWav: path.join(dir, "test_wavs", "bria.wav"),
    };
  }
  if (kind === "kitten") {
    return {
      model: { kitten: espeakModel(path.join(ttsRoot, "kitten-nano-en-v0_8-int8"), "model.int8.onnx") },
    };
  }
  // fp32: int8 Kokoro measured 3-4x slower on Apple Silicon CPUs.
  return { model: { kokoro: espeakModel(path.join(ttsRoot, "kokoro-en-v0_19"), "model.onnx") } };
}

const clampSilenceMs = (value, fallback) =>
  Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, Number(value) || fallback));

/**
 * Smart Turn: Silero cuts at a short pause and the classifier decides whether the
 * turn is over; max silence commits the turn when the classifier keeps saying no.
 */
function smartTurnConfig(cacheDir, pauseMs, maxSilenceMs) {
  return {
    model: path.join(cacheDir, "turn-models", "smart-turn-v3.2-cpu.onnx"),
    maxSilenceMs: Math.max(pauseMs, Number(maxSilenceMs) || SMART_TURN_MAX_SILENCE_MS),
    // Pipecat uses 0.5; offline, 0.8 kept the same turn-end speed with fewer mid-sentence cuts.
    threshold: 0.8,
    numThreads: 4,
  };
}

/** Worker config for the local voice spike; model paths are fixed spike downloads. */
function buildVoiceWorkerConfig({
  cacheDir,
  ttsKind,
  silenceMs,
  numThreads = 4,
  smartTurn = false,
  smartTurnMaxSilenceMs,
}) {
  const kind = resolveTtsKind(ttsKind);
  const { model, pocketVoiceWav } = ttsModelFor(kind, path.join(cacheDir, "tts-models"));
  const clampedSilenceMs = clampSilenceMs(
    silenceMs,
    smartTurn ? SMART_TURN_PAUSE_MS : DEFAULT_SILENCE_MS
  );
  return {
    ttsKind: kind,
    smartTurn: smartTurn
      ? smartTurnConfig(cacheDir, clampedSilenceMs, smartTurnMaxSilenceMs)
      : null,
    tts: {
      model: { ...model, numThreads, provider: "cpu" },
      maxNumSentences: 1,
    },
    pocketVoiceWav,
    vad: {
      sileroVad: {
        model: path.join(cacheDir, "vad-models", "silero_vad.onnx"),
        threshold: 0.5,
        minSilenceDuration: clampedSilenceMs / 1000,
        minSpeechDuration: 0.25,
        maxSpeechDuration: 20,
        windowSize: 512,
      },
      sampleRate: VAD_SAMPLE_RATE,
      numThreads: 1,
      provider: "cpu",
      debug: false,
    },
  };
}

// English-first: a voice turn is short, so the fastest downloaded model wins.
const PARAKEET_FALLBACK_ORDER = [
  "parakeet-unified-en-0.6b",
  "parakeet-tdt-0.6b-v3",
  "nemotron-speech-streaming-en-0.6b",
  "nemotron-3.5-asr-streaming-0.6b",
];

/**
 * The settings' Parakeet model may not be downloaded (e.g. cloud transcription
 * users), so the spike uses the first downloaded candidate instead.
 */
function resolveSpikeParakeetModel(requested, isDownloaded) {
  if (requested && isDownloaded(requested)) return requested;
  return PARAKEET_FALLBACK_ORDER.find((name) => isDownloaded(name)) || requested;
}

function float32ToPcm16Buffer(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767), index * 2);
  }
  return buffer;
}

module.exports = {
  VAD_SAMPLE_RATE,
  buildVoiceWorkerConfig,
  resolveTtsKind,
  resolveSpikeParakeetModel,
  float32ToPcm16Buffer,
};
