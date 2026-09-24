#!/usr/bin/env node
// Downloads the models the local voice spike (OPENWHISPR_VOICE_SPIKE=1) and its
// harness need into ~/.cache/openwhispr, so the harness runs on any machine.
// The voice brain (a GGUF LLM) comes from the app's own model manager.
//
//   node scripts/download-voice-models.js            # VAD, Smart Turn, Pocket TTS
//   node scripts/download-voice-models.js --kokoro   # also Kokoro fp32 (~320 MB)
//   node scripts/download-voice-models.js --kitten   # also Kitten nano (~31 MB)
//   add --force to re-download
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { downloadFile } = require("./lib/download-utils");

const CACHE = path.join(os.homedir(), ".cache", "openwhispr");
const SHERPA_TTS = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models";

const MODELS = [
  {
    id: "silero-vad",
    note: "Silero VAD (MIT), 0.6 MB",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    dest: path.join(CACHE, "vad-models", "silero_vad.onnx"),
  },
  {
    id: "smart-turn",
    note: "Pipecat Smart Turn v3.2 (BSD-2-Clause), 8.7 MB",
    url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx",
    dest: path.join(CACHE, "turn-models", "smart-turn-v3.2-cpu.onnx"),
  },
  {
    id: "pocket-tts",
    note: "Kyutai Pocket TTS int8 (CC-BY-4.0; its reference voice clip is for testing only), 98 MB",
    archive: `${SHERPA_TTS}/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2`,
    dest: path.join(CACHE, "tts-models", "sherpa-onnx-pocket-tts-int8-2026-01-26"),
  },
  {
    id: "kokoro",
    optIn: "--kokoro",
    note: "Kokoro fp32 (Apache-2.0; phonemizes with GPL espeak-ng data), 320 MB",
    archive: `${SHERPA_TTS}/kokoro-en-v0_19.tar.bz2`,
    dest: path.join(CACHE, "tts-models", "kokoro-en-v0_19"),
  },
  {
    id: "kitten",
    optIn: "--kitten",
    note: "Kitten nano int8 (Apache-2.0; phonemizes with GPL espeak-ng data), 31 MB",
    archive: `${SHERPA_TTS}/kitten-nano-en-v0_8-int8.tar.bz2`,
    dest: path.join(CACHE, "tts-models", "kitten-nano-en-v0_8-int8"),
  },
];

async function fetchModel(model, force) {
  if (fs.existsSync(model.dest) && !force) {
    console.log(`[voice-models] ${model.id}: already present`);
    return;
  }
  console.log(`[voice-models] ${model.id}: ${model.note}`);
  fs.mkdirSync(path.dirname(model.dest), { recursive: true });
  if (!model.archive) {
    await downloadFile(model.url, model.dest);
    return;
  }
  const archivePath = `${model.dest}.tar.bz2`;
  await downloadFile(model.archive, archivePath);
  try {
    // bsdtar (macOS, Windows 10+) and GNU tar both read bzip2 archives.
    execFileSync("tar", ["-xjf", archivePath, "-C", path.dirname(model.dest)], { stdio: "inherit" });
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
  if (!fs.existsSync(model.dest)) {
    throw new Error(`${model.id}: archive did not contain ${path.basename(model.dest)}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const wanted = MODELS.filter((model) => !model.optIn || argv.includes(model.optIn));
  for (const model of wanted) await fetchModel(model, force);
  console.log(`[voice-models] done: ${wanted.map((model) => model.id).join(", ")} in ${CACHE}`);
}

main().catch((error) => {
  console.error(`[voice-models] failed: ${error.message}`);
  process.exit(1);
});
