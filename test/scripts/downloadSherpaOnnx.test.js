const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  SHERPA_ONNX_VERSION,
  findStaleVersionedLibraries,
  isCompleteInstall,
  pruneStaleLibraries,
} = require("../../scripts/download-sherpa-onnx");

function makeBinDir(fileNames) {
  const binDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sherpa-bin-"));
  for (const fileName of fileNames) fs.writeFileSync(path.join(binDirectory, fileName), "x");
  return binDirectory;
}

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

// pruneStaleLibraries deletes from a resources/bin shared with the whisper.cpp, llama.cpp and
// qdrant sidecars, and runs on the already-installed path where nothing was downloaded, so what
// it removes is worth pinning against a real directory rather than the selector alone.
test("pruneStaleLibraries removes only the leftovers from the directory", () => {
  const binDirectory = makeBinDir([
    "libonnxruntime.dylib",
    "libonnxruntime.1.27.0.dylib",
    "libsherpa-onnx-c-api.dylib",
    "libllama.0.0.9763.dylib",
    "sherpa-onnx-ws-darwin-arm64",
  ]);

  try {
    pruneStaleLibraries(
      "darwin-arm64",
      ["libonnxruntime.dylib", "libsherpa-onnx-c-api.dylib"],
      binDirectory
    );

    assert.deepEqual(fs.readdirSync(binDirectory).sort(), [
      "libllama.0.0.9763.dylib",
      "libonnxruntime.dylib",
      "libsherpa-onnx-c-api.dylib",
      "sherpa-onnx-ws-darwin-arm64",
    ]);
  } finally {
    fs.rmSync(binDirectory, { recursive: true, force: true });
  }
});

test("isCompleteInstall accepts an install matching the pinned version", () => {
  const binDirectory = makeBinDir(["libonnxruntime.dylib", "sherpa-onnx-ws-darwin-arm64"]);
  const binaryPath = path.join(binDirectory, "sherpa-onnx-ws-darwin-arm64");

  try {
    const marker = { version: SHERPA_ONNX_VERSION, libraries: ["libonnxruntime.dylib"] };
    assert.equal(isCompleteInstall(marker, [binaryPath], binDirectory), true);
    // A version bump has to re-download rather than reuse the older release's libraries.
    assert.equal(
      isCompleteInstall({ ...marker, version: "0.0.0" }, [binaryPath], binDirectory),
      false
    );
    // So does a binary the install marker claims but the directory does not have.
    assert.equal(
      isCompleteInstall(marker, [path.join(binDirectory, "missing")], binDirectory),
      false
    );
    assert.equal(
      isCompleteInstall(
        { version: SHERPA_ONNX_VERSION, libraries: ["libonnxruntime.dylib", "gone.dylib"] },
        [binaryPath],
        binDirectory
      ),
      false
    );
  } finally {
    fs.rmSync(binDirectory, { recursive: true, force: true });
  }
});

// A marker that parses but holds a non-string entry must read as incomplete, not throw out of
// downloadBinary -- that aborts the whole run and packaging continues with no sherpa binaries.
test("isCompleteInstall rejects a marker whose libraries are not names", () => {
  // The real library is present, so the check reaches the entry that is not a name.
  const binDirectory = makeBinDir(["libonnxruntime.dylib", "sherpa-onnx-ws-darwin-arm64"]);
  const binaryPath = path.join(binDirectory, "sherpa-onnx-ws-darwin-arm64");

  try {
    assert.equal(
      isCompleteInstall(
        { version: SHERPA_ONNX_VERSION, libraries: ["libonnxruntime.dylib", 123] },
        [binaryPath],
        binDirectory
      ),
      false
    );
    assert.equal(isCompleteInstall(null, [binaryPath], binDirectory), false);
  } finally {
    fs.rmSync(binDirectory, { recursive: true, force: true });
  }
});
