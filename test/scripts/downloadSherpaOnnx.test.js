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

// The symlink dedup writes libonnxruntime.dylib itself when the archive ships only versioned
// libraries, so the prune must not read that name as a leftover and delete it.
test("keeps the symlink the run just wrote for a versioned-only archive", () => {
  const stale = findStaleVersionedLibraries(
    ["libonnxruntime.dylib", "libonnxruntime.1.28.0.dylib"],
    ["libonnxruntime.1.28.0.dylib"]
  );

  assert.deepEqual(stale, []);
});

test("matches a stale sibling by base name when only versioned libraries were copied", () => {
  const stale = findStaleVersionedLibraries(
    ["libonnxruntime.1.26.0.dylib", "libonnxruntime.1.27.0.dylib"],
    ["libonnxruntime.1.27.0.dylib"]
  );

  assert.deepEqual(stale, ["libonnxruntime.1.26.0.dylib"]);
});

// The packaging check spots any versioned ONNX Runtime naming, so the prune has to remove the
// same shapes -- a two-component leftover included.
test("removes a leftover whose version has two components", () => {
  const stale = findStaleVersionedLibraries(
    ["libonnxruntime.dylib", "libonnxruntime.1.27.dylib"],
    ["libonnxruntime.dylib"]
  );

  assert.deepEqual(stale, ["libonnxruntime.1.27.dylib"]);
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
