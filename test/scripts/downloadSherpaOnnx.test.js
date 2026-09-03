const test = require("node:test");
const assert = require("node:assert/strict");

const { findStaleVersionedLibraries } = require("../../scripts/download-sherpa-onnx");

test("removes the versioned ONNX Runtime an older sherpa-onnx release left behind", () => {
  // 1.13.6 ships libonnxruntime.dylib alone; the 1.13.4 file has nothing to overwrite it.
  const stale = findStaleVersionedLibraries(
    [
      "libonnxruntime.1.27.0.dylib",
      "libonnxruntime.dylib",
      "libsherpa-onnx-c-api.dylib",
      "sherpa-onnx-ws-darwin-arm64",
    ],
    ["libonnxruntime.dylib", "libsherpa-onnx-c-api.dylib", "libsherpa-onnx-cxx-api.dylib"]
  );

  assert.deepEqual(stale, ["libonnxruntime.1.27.0.dylib"]);
});

test("keeps the versioned library this run copied and drops the older one", () => {
  const stale = findStaleVersionedLibraries(
    ["libonnxruntime.1.26.0.dylib", "libonnxruntime.1.27.0.dylib", "libonnxruntime.dylib"],
    ["libonnxruntime.1.27.0.dylib", "libonnxruntime.dylib"]
  );

  assert.deepEqual(stale, ["libonnxruntime.1.26.0.dylib"]);
});

test("leaves libraries from another platform's download alone", () => {
  const stale = findStaleVersionedLibraries(
    ["libonnxruntime.1.27.0.dylib", "libonnxruntime.dylib", "onnxruntime.dll"],
    ["onnxruntime.dll", "sherpa-onnx-c-api.dll"]
  );

  assert.deepEqual(stale, []);
});

test("never reports unversioned libraries or the sherpa binaries", () => {
  const stale = findStaleVersionedLibraries(
    [
      "libonnxruntime.dylib",
      "libsherpa-onnx-cxx-api.dylib",
      "sherpa-onnx-online-ws-darwin-arm64",
      ".sherpa-onnx-darwin-arm64.json",
    ],
    ["libonnxruntime.dylib", "libsherpa-onnx-c-api.dylib"]
  );

  assert.deepEqual(stale, []);
});
