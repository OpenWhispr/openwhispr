const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SHERPA_ONNX_VERSION,
  findObsoleteLibraries,
} = require("../../scripts/download-sherpa-onnx");

test("pins the current sherpa-onnx release", () => {
  assert.equal(SHERPA_ONNX_VERSION, "1.13.7");
});

test("removes only libraries from the previous sherpa-onnx install", () => {
  const obsolete = findObsoleteLibraries(
    ["libonnxruntime.1.27.0.dylib", "libonnxruntime.dylib", "libsherpa-onnx-c-api.dylib"],
    ["libonnxruntime.dylib", "libsherpa-onnx-c-api.dylib"],
    ["libonnxruntime.1.27.0.dylib", "libonnxruntime.dylib", "libllama.dylib"]
  );

  assert.deepEqual(obsolete, ["libonnxruntime.1.27.0.dylib"]);
});
