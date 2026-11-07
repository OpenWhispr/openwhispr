const fs = require("fs");
const path = require("path");
const { getModelsDirForService } = require("./modelDirUtils");
const { isProcessAlive } = require("./sidecarReaper");

// Supertonic 3 (Supertone, OpenRAIL-M weights; licence in src/assets/licenses): fixed
// voices, so every sentence sounds like the same speaker, and a character-level text
// front end, so it needs no espeak-ng data.
const SUPERTONIC_DIR = "sherpa-onnx-supertonic-3-tts-int8-2026-05-11";
const SUPERTONIC_FILES = {
  durationPredictor: "duration_predictor.int8.onnx",
  textEncoder: "text_encoder.int8.onnx",
  vectorEstimator: "vector_estimator.int8.onnx",
  vocoder: "vocoder.int8.onnx",
  ttsJson: "tts.json",
  unicodeIndexer: "unicode_indexer.bin",
  voiceStyle: "voice.bin",
};

// Every download is pinned by hash: the GitHub release tags are rolling and a Hugging
// Face branch moves, so an upstream swap fails the check instead of installing a
// different model. Updating a model means a new URL and hash here.
const VOICE_MODELS = [
  {
    id: "vad",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    archive: false,
    target: "silero_vad.onnx",
    requiredFiles: ["silero_vad.onnx"],
    approxBytes: 650_000,
  },
  {
    id: "smart-turn",
    url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93/smart-turn-v3.2-cpu.onnx",
    sha256: "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
    archive: false,
    target: "smart-turn-v3.2-cpu.onnx",
    requiredFiles: ["smart-turn-v3.2-cpu.onnx"],
    approxBytes: 8_700_000,
  },
  {
    id: "supertonic-tts",
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${SUPERTONIC_DIR}.tar.bz2`,
    sha256: "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427",
    archive: true,
    target: SUPERTONIC_DIR,
    requiredFiles: Object.values(SUPERTONIC_FILES).map((file) => path.join(SUPERTONIC_DIR, file)),
    approxBytes: 128_800_000,
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
  const supertonicDir = path.join(modelsDir, SUPERTONIC_DIR);
  const supertonic = Object.fromEntries(
    Object.entries(SUPERTONIC_FILES).map(([key, file]) => [key, path.join(supertonicDir, file)])
  );
  return {
    vad: path.join(modelsDir, "silero_vad.onnx"),
    smartTurn: path.join(modelsDir, "smart-turn-v3.2-cpu.onnx"),
    supertonic,
  };
}

// An archive is extracted beside its download (Supertonic's ~129 MB unpacks to
// ~146 MB) and may replace an earlier copy, so reserve three times the download size.
const DISK_SPACE_FACTOR = 3;

function defaultDeps() {
  const logger = require("./debugLogger");
  const { downloadFile, checkDiskSpace, sha256File } = require("./downloadUtils");
  const { extractTarBz2 } = require("./systemTar");
  return {
    downloadFile,
    checkDiskSpace,
    sha256File,
    extractTarBz2: (archivePath, destDir) => extractTarBz2(archivePath, destDir, { logger }),
    logger,
  };
}

const stagingPrefix = (model) => `.${model.target}.partial-`;

function findMissingFile(model, rootDir) {
  return model.requiredFiles.find((file) => !fs.existsSync(path.join(rootDir, file)));
}

// Windows refuses to delete a file another process holds open (EBUSY). A
// leftover is cleared by a later run, so cleanup must never turn a finished
// install into a failure, or replace the error that made it fail.
function removeBestEffort(target, logger) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    logger.warn("Voice model cleanup failed", { path: target, error: error.message });
  }
}

// Status only checks that files exist, so an archive must never be extracted
// in place: a crash mid-write would leave every file present and one truncated
// (reported ready, then the worker fails), and a status check during
// extraction could see it ready early. Extract beside the target, verify, then
// swap the whole directory in with one rename.
async function extractArchiveModel(
  model,
  archivePath,
  modelsDir,
  { extractTarBz2, signal, logger }
) {
  const stagingDir = path.join(modelsDir, `${stagingPrefix(model)}${process.pid}-${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    await extractTarBz2(archivePath, stagingDir);
    // Extraction doesn't watch the signal, so a cancel during it lands here.
    if (signal?.aborted) {
      throw Object.assign(new Error("Download cancelled"), { isAbort: true });
    }
    const missingFile = findMissingFile(model, stagingDir);
    if (missingFile) {
      throw new Error(`${model.id}: download finished but ${missingFile} is missing`);
    }
    const targetDir = path.join(modelsDir, model.target);
    if (fs.existsSync(targetDir)) {
      // An incomplete earlier copy; moved into staging so the cleanup drops it.
      fs.renameSync(targetDir, path.join(stagingDir, "previous"));
    }
    fs.renameSync(path.join(stagingDir, model.target), targetDir);
  } finally {
    removeBestEffort(stagingDir, logger);
  }
}

// A crash skips the cleanup above, so clear staging whose process is gone.
// Staging owned by a live process (a second instance, or the dev download
// script beside the app) may still be mid-extraction.
function removeStaleStaging(modelsDir, logger) {
  const prefixes = VOICE_MODELS.filter((model) => model.archive).map(stagingPrefix);
  for (const name of fs.readdirSync(modelsDir)) {
    const prefix = prefixes.find((candidate) => name.startsWith(candidate));
    if (prefix && !isProcessAlive(Number.parseInt(name.slice(prefix.length), 10))) {
      removeBestEffort(path.join(modelsDir, name), logger);
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
  const { downloadFile, extractTarBz2, checkDiskSpace, sha256File, logger } = {
    ...defaultDeps(),
    ...deps,
  };
  fs.mkdirSync(modelsDir, { recursive: true });
  removeStaleStaging(modelsDir, logger);
  const requiredBytes = getVoiceModelStatus(modelsDir).missingBytes * DISK_SPACE_FACTOR;
  const spaceCheck = await checkDiskSpace(modelsDir, requiredBytes);
  if (!spaceCheck.ok) {
    throw new Error(
      `Not enough disk space. Need ~${Math.round(requiredBytes / 1_000_000)}MB, ` +
        `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
    );
  }
  for (const model of VOICE_MODELS) {
    if (isPresent(model, modelsDir, fs.existsSync)) continue;
    // Nothing lands under its real name until its hash checks out, so a truncated
    // or substituted download never reads as ready.
    const dest = path.join(
      modelsDir,
      model.archive ? `${model.target}.tar.bz2` : `${model.target}.download`
    );
    await downloadFile(model.url, dest, {
      signal,
      onProgress: (downloadedBytes, totalBytes) =>
        onProgress({ model: model.id, downloadedBytes, totalBytes }),
    });
    try {
      const actual = await sha256File(dest);
      if (actual !== model.sha256) {
        throw new Error(
          `${model.id}: download failed its checksum (sha256 ${actual}, expected ${model.sha256})`
        );
      }
      if (model.archive) {
        await extractArchiveModel(model, dest, modelsDir, { extractTarBz2, signal, logger });
      } else {
        fs.renameSync(dest, path.join(modelsDir, model.target));
      }
    } finally {
      removeBestEffort(dest, logger);
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
