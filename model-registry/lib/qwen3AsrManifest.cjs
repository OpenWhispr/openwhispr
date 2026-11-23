const MAX_MANIFEST_BYTES = 16384;
const files = [
  "conv_frontend.onnx",
  "encoder.int8.onnx",
  "encoder.int8.onnx.data",
  "decoder.int8.onnx",
  "decoder.int8.onnx.data",
  "tokenizer/config.json",
  "tokenizer/merges.txt",
  "tokenizer/tokenizer.json",
  "tokenizer/tokenizer_config.json",
  "tokenizer/vocab.json",
];

function parseChecksums(text) {
  const remaining = new Set(files);
  const entries = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([\w./-]+)$/.exec(line);
    if (!match || !remaining.delete(match[2])) throw new Error("Invalid Qwen3 ASR bundle manifest");
    entries.push({ name: match[2], sha256: match[1] });
  }
  if (remaining.size) throw new Error("Incomplete Qwen3 ASR bundle manifest");
  return entries;
}

module.exports = { MAX_MANIFEST_BYTES, files, parseChecksums };
