const fs = require("node:fs/promises");
const path = require("node:path");

const {
  MAX_MANIFEST_BYTES,
  files,
  parseChecksums,
} = require("../../model-registry/lib/qwen3AsrManifest.cjs");

function decoderArgs(dir) {
  return [
    "--feat-dim=128",
    "--max-batch-size=1",
    `--qwen3-asr-conv-frontend=${path.join(dir, "conv_frontend.onnx")}`,
    `--qwen3-asr-encoder=${path.join(dir, "encoder.int8.onnx")}`,
    `--qwen3-asr-decoder=${path.join(dir, "decoder.int8.onnx")}`,
    `--qwen3-asr-tokenizer=${path.join(dir, "tokenizer")}`,
  ];
}

async function installBundle(config, target, { download, signal, onProgress, beforePublish }) {
  const staging = await fs.mkdtemp(
    path.join(path.dirname(target), "temp-extract-" + path.basename(target) + "-")
  );
  try {
    const manifest = path.join(staging, "SHA256SUMS");
    await download(config.url, manifest, { expectedSha256: config.sha256, signal });
    if ((await fs.stat(manifest)).size > MAX_MANIFEST_BYTES)
      throw new Error("Oversized Qwen3 ASR manifest");
    const entries = parseChecksums(await fs.readFile(manifest, "utf8"));
    await fs.mkdir(path.join(staging, "tokenizer"));
    let done = 0;
    for (const { name, sha256 } of entries) {
      if (signal.aborted) throw Object.assign(new Error("Download cancelled"), { isAbort: true });
      const file = path.join(staging, name);
      await download(new URL(name, config.url).href, file, {
        expectedSha256: sha256,
        signal,
        onProgress: (bytes) => onProgress(done + bytes, config.size),
      });
      done += (await fs.stat(file)).size;
    }
    if (done !== config.size) throw new Error("Qwen3 ASR bundle size mismatch");
    if (signal.aborted) throw Object.assign(new Error("Download cancelled"), { isAbort: true });
    beforePublish();
    // The manager already returned for a complete installation. Replace only a
    // broken model directory, after every byte of its replacement is verified.
    try {
      await fs.rename(staging, target);
    } catch (error) {
      if (!["ENOTEMPTY", "EEXIST", "EPERM"].includes(error.code)) throw error;
      const old = staging + ".old";
      await fs.rename(target, old);
      try {
        await fs.rename(staging, target);
      } catch (installError) {
        await fs.rename(old, target);
        throw installError;
      }
      await fs.rm(old, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

module.exports = { files, parseChecksums, decoderArgs, installBundle };
