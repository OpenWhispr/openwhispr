const fs = require("fs");
const path = require("path");
const { getModelsDirForService } = require("./modelDirUtils");

const POCKET_DIR = "sherpa-onnx-pocket-tts-int8-2026-01-26";
// Release gate: the publisher marks this clip test-only; ship a licensed clip.
const POCKET_REFERENCE_VOICE = path.join("test_wavs", "bria.wav");
const POCKET_FILES = {
  lmFlow: "lm_flow.int8.onnx",
  lmMain: "lm_main.int8.onnx",
  encoder: "encoder.onnx",
  decoder: "decoder.int8.onnx",
  textConditioner: "text_conditioner.onnx",
  vocabJson: "vocab.json",
  tokenScoresJson: "token_scores.json",
  referenceVoiceWav: POCKET_REFERENCE_VOICE,
};

const VOICE_MODELS = [
  {
    id: "vad",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    archive: false,
    target: "silero_vad.onnx",
    requiredFiles: ["silero_vad.onnx"],
    approxBytes: 650_000,
  },
  {
    id: "smart-turn",
    url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx",
    archive: false,
    target: "smart-turn-v3.2-cpu.onnx",
    requiredFiles: ["smart-turn-v3.2-cpu.onnx"],
    approxBytes: 8_700_000,
  },
  {
    id: "pocket-tts",
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${POCKET_DIR}.tar.bz2`,
    archive: true,
    target: POCKET_DIR,
    requiredFiles: Object.values(POCKET_FILES).map((file) => path.join(POCKET_DIR, file)),
    approxBytes: 98_000_000,
  },
];

function getVoiceModelsDir() {
  return getModelsDirForService("voice");
}

const isPresent = (model, modelsDir, exists) =>
  model.requiredFiles.every((file) => exists(path.join(modelsDir, file)));

function getVoiceModelStatus(modelsDir = getVoiceModelsDir(), exists = fs.existsSync) {
  const missingModels = VOICE_MODELS.filter((model) => !isPresent(model, modelsDir, exists));
  return {
    ready: missingModels.length === 0,
    missing: missingModels.map((model) => model.id),
    missingBytes: missingModels.reduce((total, model) => total + model.approxBytes, 0),
  };
}

function getVoiceModelPaths(modelsDir = getVoiceModelsDir()) {
  const pocketDir = path.join(modelsDir, POCKET_DIR);
  const pocket = Object.fromEntries(
    Object.entries(POCKET_FILES).map(([key, file]) => [key, path.join(pocketDir, file)])
  );
  return {
    vad: path.join(modelsDir, "silero_vad.onnx"),
    smartTurn: path.join(modelsDir, "smart-turn-v3.2-cpu.onnx"),
    pocket,
  };
}

function defaultDeps() {
  return {
    downloadFile: require("./downloadUtils").downloadFile,
    extractTarBz2: require("./systemTar").extractTarBz2,
  };
}

/** Downloads whatever is missing; resolves with the final status or throws. */
async function downloadVoiceModels({
  modelsDir = getVoiceModelsDir(),
  signal,
  onProgress = () => {},
  deps = {},
} = {}) {
  const { downloadFile, extractTarBz2 } = { ...defaultDeps(), ...deps };
  fs.mkdirSync(modelsDir, { recursive: true });
  for (const model of VOICE_MODELS) {
    if (isPresent(model, modelsDir, fs.existsSync)) continue;
    const dest = path.join(modelsDir, model.archive ? `${model.target}.tar.bz2` : model.target);
    await downloadFile(model.url, dest, {
      signal,
      onProgress: (downloadedBytes, totalBytes) =>
        onProgress({ model: model.id, downloadedBytes, totalBytes }),
    });
    if (model.archive) {
      try {
        await extractTarBz2(dest, modelsDir);
      } finally {
        fs.rmSync(dest, { force: true });
      }
    }
    const missingFile = model.requiredFiles.find((file) => !fs.existsSync(path.join(modelsDir, file)));
    if (missingFile) {
      throw new Error(`${model.id}: download finished but ${missingFile} is missing`);
    }
  }
  return getVoiceModelStatus(modelsDir);
}

module.exports = {
  VOICE_MODELS,
  getVoiceModelsDir,
  getVoiceModelStatus,
  getVoiceModelPaths,
  downloadVoiceModels,
};
