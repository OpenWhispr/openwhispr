// Per-engine details for read-aloud voices, kept pure so they can be unit-tested
// and shared by the installer (main process) and the TTS worker.
//   piper      — VITS models: one .onnx + tokens.txt + espeak-ng-data
//   supertonic — Supertonic 3: several .onnx graphs + tts.json + voice.bin,
//                one model with multiple speakers and a language tag
//   kokoro     — Kokoro v1.0: model.onnx + voices.bin + tokens.txt +
//                espeak-ng-data, one model with many speakers; `lang` picks
//                the espeak-ng voice that turns the text into phonemes
const fs = require("fs");
const path = require("path");

const ENGINES = new Set(["piper", "supertonic", "kokoro"]);

const KOKORO_FILES = {
  model: "model.onnx",
  voices: "voices.bin",
  tokens: "tokens.txt",
  dataDir: "espeak-ng-data",
};

const SUPERTONIC_FILES = {
  durationPredictor: "duration_predictor.int8.onnx",
  textEncoder: "text_encoder.int8.onnx",
  vectorEstimator: "vector_estimator.int8.onnx",
  vocoder: "vocoder.int8.onnx",
  ttsJson: "tts.json",
  unicodeIndexer: "unicode_indexer.bin",
  voiceStyle: "voice.bin",
};

function engineOf(voice) {
  return ENGINES.has(voice?.engine) ? voice.engine : "piper";
}

function hasRequiredFiles(voice, files) {
  const engine = engineOf(voice);
  if (engine === "supertonic") {
    return Object.values(SUPERTONIC_FILES).every((name) => files.includes(name));
  }
  if (engine === "kokoro") {
    return Object.values(KOKORO_FILES).every((name) => files.includes(name));
  }
  return (
    files.some((f) => f.endsWith(".onnx")) &&
    files.includes("tokens.txt") &&
    files.includes("espeak-ng-data")
  );
}

function buildModelConfig(voice, voiceDir, numThreads, listFiles = fs.readdirSync) {
  const common = { numThreads, provider: "cpu", debug: false };
  if (engineOf(voice) === "kokoro") {
    const kokoro = { lang: voice.lang ?? "pt-br" };
    for (const [key, name] of Object.entries(KOKORO_FILES)) {
      kokoro[key] = path.join(voiceDir, name);
    }
    // Lexicons only for the language they belong to: the archive's lexicons
    // are English and Chinese, and a Portuguese word found there ("a", "do")
    // would be read with English sounds.
    if (voice.lexicon) kokoro.lexicon = path.join(voiceDir, voice.lexicon);
    return { model: { kokoro, ...common }, maxNumSentences: 1 };
  }
  if (engineOf(voice) === "supertonic") {
    const supertonic = {};
    for (const [key, name] of Object.entries(SUPERTONIC_FILES)) {
      supertonic[key] = path.join(voiceDir, name);
    }
    return { model: { supertonic, ...common }, maxNumSentences: 1 };
  }
  const modelFile = listFiles(voiceDir).find((f) => f.endsWith(".onnx"));
  if (!modelFile) throw new Error(`No .onnx model in ${voiceDir}`);
  return {
    model: {
      vits: {
        model: path.join(voiceDir, modelFile),
        tokens: path.join(voiceDir, "tokens.txt"),
        dataDir: path.join(voiceDir, "espeak-ng-data"),
      },
      ...common,
    },
    maxNumSentences: 1,
  };
}

// Request for OfflineTts.generateAsync. Electron's V8 memory cage rejects
// external ArrayBuffers, so enableExternalBuffer is always false.
function buildGenerationRequest(voice, text, speed = 1) {
  const sid = voice?.sid ?? 0;
  const request = { text, sid, speed, enableExternalBuffer: false };
  if (engineOf(voice) === "supertonic") {
    request.generationConfig = {
      sid,
      speed,
      numSteps: voice.numSteps ?? 16,
      extra: { lang: voice.lang ?? "pt" },
    };
  }
  return request;
}

// Speakers of one archive share a loaded model only when it was built for the
// same language and lexicon; otherwise the worker must load it again.
function modelKey(voice, voiceDir) {
  if (engineOf(voice) !== "kokoro") return voiceDir;
  return [voiceDir, voice.lang ?? "pt-br", voice.lexicon ?? ""].join("|");
}

module.exports = {
  modelKey,
  SUPERTONIC_FILES,
  KOKORO_FILES,
  engineOf,
  hasRequiredFiles,
  buildModelConfig,
  buildGenerationRequest,
};
