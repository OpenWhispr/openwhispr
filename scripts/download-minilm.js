#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { downloadFile, parseArgs } = require("./lib/download-utils");

const forBuild = process.argv.includes("--for-build");
const MODEL_DIR = forBuild
  ? path.join(__dirname, "..", "resources", "bin", "all-MiniLM-L6-v2")
  : path.join(os.homedir(), ".cache", "openwhispr", "embedding-models", "all-MiniLM-L6-v2");

const FILES = [
  {
    name: "model.onnx",
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/onnx/model.onnx",
  },
  {
    name: "tokenizer.json",
    url: "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
  },
];

async function main() {
  console.log("\n[embedding-model] Downloading all-MiniLM-L6-v2 ONNX model...\n");

  const args = parseArgs();

  const allExist = FILES.every((f) => fs.existsSync(path.join(MODEL_DIR, f.name)));
  if (allExist && !args.isForce) {
    console.log("[embedding-model] Model files already exist (use --force to re-download)\n");
    return;
  }

  fs.mkdirSync(MODEL_DIR, { recursive: true });

  for (const file of FILES) {
    const destPath = path.join(MODEL_DIR, file.name);

    if (fs.existsSync(destPath) && !args.isForce) {
      console.log(`[embedding-model] ${file.name} already exists, skipping`);
      continue;
    }

    console.log(`[embedding-model] Downloading ${file.name} from ${file.url}`);

    try {
      await downloadFile(file.url, destPath);
      const stats = fs.statSync(destPath);
      const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
      console.log(`[embedding-model] ${file.name} downloaded (${sizeMB}MB)`);
    } catch (error) {
      console.error(`[embedding-model] Failed to download ${file.name}: ${error.message}`);
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`\n[embedding-model] Model ready at ${MODEL_DIR}\n`);
}

main().catch(console.error);
