#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { downloadFile, parseArgs } = require("./lib/download-utils");

const VAD_MODEL_URL =
  "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin";
const VAD_MODEL_FILE = "ggml-silero-v5.1.2.bin";

function getOutputDir() {
  const outputDirIndex = process.argv.indexOf("--output-dir");
  if (outputDirIndex !== -1 && process.argv[outputDirIndex + 1]) {
    return path.resolve(process.argv[outputDirIndex + 1]);
  }
  return path.join(__dirname, "..", "resources", "bin", "whisper-vad");
}

async function main() {
  const args = parseArgs();
  const outputDir = getOutputDir();
  const outputPath = path.join(outputDir, VAD_MODEL_FILE);

  if (fs.existsSync(outputPath) && !args.isForce) {
    console.log(`[whisper-vad-model] ${VAD_MODEL_FILE} already exists`);
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });

  console.log(`[whisper-vad-model] Downloading ${VAD_MODEL_FILE}`);
  try {
    await downloadFile(VAD_MODEL_URL, outputPath);
    const sizeKb = Math.round(fs.statSync(outputPath).size / 1024);
    console.log(`[whisper-vad-model] Downloaded ${VAD_MODEL_FILE} (${sizeKb}KB)`);
  } catch (error) {
    console.error(`[whisper-vad-model] Download failed: ${error.message}`);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    process.exitCode = 1;
  }
}

main().catch(console.error);
