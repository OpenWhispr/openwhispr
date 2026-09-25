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

const stagingPrefix = (model) => `.${model.target}.partial-`;

function findMissingFile(model, rootDir) {
  return model.requiredFiles.find((file) => !fs.existsSync(path.join(rootDir, file)));
}

// Status only checks that files exist, so an archive must never be extracted
// in place: a crash mid-write would leave every file present and one truncated
// (reported ready, then the worker fails), and a status check during
// extraction could see it ready early. Extract beside the target, verify, then
// swap the whole directory in with one rename.
async function extractArchiveModel(model, archivePath, modelsDir, extractTarBz2) {
  const stagingDir = path.join(modelsDir, `${stagingPrefix(model)}${process.pid}-${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    await extractTarBz2(archivePath, stagingDir);
    const missingFile = findMissingFile(model, stagingDir);
    if (missingFile) {
      throw new Error(`${model.id}: download finished but ${missingFile} is missing`);
    }
    const targetDir = path.join(modelsDir, model.target);
    if (fs.existsSync(targetDir)) {
      // An incomplete earlier copy; moved into staging so the finally drops it.
      fs.renameSync(targetDir, path.join(stagingDir, "previous"));
    }
    fs.renameSync(path.join(stagingDir, model.target), targetDir);
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

// A crash skips the finally above; clear staging left by an earlier process.
function removeStaleStaging(modelsDir) {
  const ownPrefixes = VOICE_MODELS.filter((model) => model.archive).map(stagingPrefix);
  const ownPid = `${process.pid}-`;
  for (const name of fs.readdirSync(modelsDir)) {
    const prefix = ownPrefixes.find((candidate) => name.startsWith(candidate));
    if (prefix && !name.slice(prefix.length).startsWith(ownPid)) {
      fs.rmSync(path.join(modelsDir, name), { recursive: true, force: true });
    }
  }
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
  removeStaleStaging(modelsDir);
  for (const model of VOICE_MODELS) {
    if (isPresent(model, modelsDir, fs.existsSync)) continue;
    // Single-file models land atomically: downloadFile writes `${dest}.tmp`
    // and renames it into place only once complete.
    const dest = path.join(modelsDir, model.archive ? `${model.target}.tar.bz2` : model.target);
    await downloadFile(model.url, dest, {
      signal,
      onProgress: (downloadedBytes, totalBytes) =>
        onProgress({ model: model.id, downloadedBytes, totalBytes }),
    });
    if (model.archive) {
      try {
        await extractArchiveModel(model, dest, modelsDir, extractTarBz2);
      } finally {
        fs.rmSync(dest, { force: true });
      }
    }
    const missingFile = findMissingFile(model, modelsDir);
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
