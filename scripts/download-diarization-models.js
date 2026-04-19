#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { downloadFile, parseArgs } = require("./lib/download-utils");

const SEGMENTATION_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2";
const SEGMENTATION_DIR = "sherpa-onnx-pyannote-segmentation-3-0";
const SEGMENTATION_FILE = "model.onnx";

const EMBEDDING_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const EMBEDDING_FILE = "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx";
const VAD_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
const VAD_FILE = "silero_vad.onnx";

function getModelDir() {
  const outputDirIndex = process.argv.indexOf("--output-dir");
  if (outputDirIndex !== -1 && process.argv[outputDirIndex + 1]) {
    return path.resolve(process.argv[outputDirIndex + 1]);
  }

  if (process.env.DIARIZATION_MODEL_DIR) {
    return path.resolve(process.env.DIARIZATION_MODEL_DIR);
  }

  return path.join(os.homedir(), ".cache", "openwhispr", "diarization-models");
}

function extractTarBz2(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const cwd = path.dirname(archivePath);
  execFileSync("tar", ["-xjf", path.basename(archivePath), "-C", path.relative(cwd, destDir)], {
    stdio: "inherit",
    cwd,
  });
}

async function main() {
  console.log("\n[diarization-models] Downloading diarization models...\n");

  const args = parseArgs();
  const modelDir = getModelDir();

  const segModelPath = path.join(modelDir, SEGMENTATION_DIR, SEGMENTATION_FILE);
  const embModelPath = path.join(modelDir, EMBEDDING_FILE);
  const vadModelPath = path.join(modelDir, VAD_FILE);

  const allExist =
    fs.existsSync(segModelPath) && fs.existsSync(embModelPath) && fs.existsSync(vadModelPath);
  if (allExist && !args.isForce) {
    console.log("[diarization-models] Model files already exist (use --force to re-download)\n");
    return;
  }

  fs.mkdirSync(modelDir, { recursive: true });

  // Download segmentation model (tar.bz2 archive)
  if (!fs.existsSync(segModelPath) || args.isForce) {
    console.log(`[diarization-models] Downloading segmentation model from ${SEGMENTATION_URL}`);

    const archivePath = path.join(modelDir, `${SEGMENTATION_DIR}.tar.bz2`);

    try {
      await downloadFile(SEGMENTATION_URL, archivePath);

      const extractDir = path.join(modelDir, "temp-segmentation");
      fs.mkdirSync(extractDir, { recursive: true });
      extractTarBz2(archivePath, extractDir);

      // Find model.onnx inside the extracted directory
      const extractedModelPath = path.join(extractDir, SEGMENTATION_DIR, SEGMENTATION_FILE);
      if (!fs.existsSync(extractedModelPath)) {
        console.error(`[diarization-models] ${SEGMENTATION_FILE} not found in archive`);
        process.exitCode = 1;
        return;
      }

      const destDir = path.join(modelDir, SEGMENTATION_DIR);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(extractedModelPath, segModelPath);

      const stats = fs.statSync(segModelPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      console.log(`[diarization-models] Segmentation model downloaded (${sizeMB}MB)`);

      // Cleanup
      fs.rmSync(extractDir, { recursive: true, force: true });
      if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
    } catch (error) {
      console.error(`[diarization-models] Failed to download segmentation model: ${error.message}`);
      if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(`[diarization-models] Segmentation model already exists, skipping`);
  }

  // Download embedding model (direct .onnx file)
  if (!fs.existsSync(embModelPath) || args.isForce) {
    console.log(`[diarization-models] Downloading embedding model from ${EMBEDDING_URL}`);

    try {
      await downloadFile(EMBEDDING_URL, embModelPath);
      const stats = fs.statSync(embModelPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      console.log(`[diarization-models] Embedding model downloaded (${sizeMB}MB)`);
    } catch (error) {
      console.error(`[diarization-models] Failed to download embedding model: ${error.message}`);
      if (fs.existsSync(embModelPath)) fs.unlinkSync(embModelPath);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log(`[diarization-models] Embedding model already exists, skipping`);
  }

  if (!fs.existsSync(vadModelPath) || args.isForce) {
    console.log(`[diarization-models] Downloading VAD model from ${VAD_URL}`);

    try {
      await downloadFile(VAD_URL, vadModelPath);
      const stats = fs.statSync(vadModelPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      console.log(`[diarization-models] VAD model downloaded (${sizeMB}MB)`);
    } catch (error) {
      console.error(`[diarization-models] Failed to download VAD model: ${error.message}`);
      if (fs.existsSync(vadModelPath)) fs.unlinkSync(vadModelPath);
      process.exitCode = 1;
      return;
    }
  } else {
    console.log("[diarization-models] VAD model already exists, skipping");
  }

  console.log(`\n[diarization-models] Models ready at ${modelDir}\n`);
}

main().catch(console.error);
