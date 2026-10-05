const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  copyLibraries,
  findLibrariesInDir,
  matchesPattern,
} = require("../../scripts/lib/download-utils");
const {
  BINARIES,
  WHISPER_CPP_TAG,
  downloadAllBinaries,
  isCompleteInstall,
} = require("../../scripts/download-whisper-cpp");

// Regression: the win32 CPU whisper-server.exe links the dynamic MSVC runtime
// (msvcp140/vcruntime140/vcruntime140_1/vcomp140). Shipping the bare exe kills it
// at load with 0xC0000135 on machines without the VC++ redistributable (CUS-113),
// so the zip's DLL companions must be extracted beside the exe like llama/sherpa do.
test("win32 whisper-server config extracts DLL companions from the release zip", () => {
  assert.equal(BINARIES["win32-x64"].libPattern, "*.dll");
  assert.deepEqual(BINARIES["win32-x64"].requiredLibraries, [
    "msvcp140.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "vcomp140.dll",
  ]);
});

test("whisper-cpp pin is a release whose win32 zips bundle the MSVC runtime DLLs", () => {
  // 0.0.8 and 0.0.9 ship a bare exe; 0.0.10 is the first tag with the DLLs.
  assert.equal(WHISPER_CPP_TAG, "0.0.10");
});

test("all-platform mode reports failure after attempting every configured download", async () => {
  const attempts = [];
  const download = async (platformArch) => {
    attempts.push(platformArch);
    return platformArch !== "win32-x64";
  };

  assert.equal(await downloadAllBinaries({ assets: [] }, false, download), false);
  assert.deepEqual(attempts, Object.keys(BINARIES));
});

test("cached win32 install is complete only for the current tag with every required DLL", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-install-test-"));
  const binaryPath = path.join(tempDir, BINARIES["win32-x64"].outputName);
  const markerPath = path.join(tempDir, ".whisper-cpp-win32-x64.json");
  const requiredLibraries = BINARIES["win32-x64"].requiredLibraries;

  fs.writeFileSync(binaryPath, "binary");
  for (const library of requiredLibraries) {
    fs.writeFileSync(path.join(tempDir, library), library);
  }

  try {
    assert.equal(isCompleteInstall(markerPath, binaryPath, BINARIES["win32-x64"]), false);

    fs.writeFileSync(
      markerPath,
      JSON.stringify({ version: "0.0.9", libraries: requiredLibraries })
    );
    assert.equal(isCompleteInstall(markerPath, binaryPath, BINARIES["win32-x64"]), false);

    fs.writeFileSync(
      markerPath,
      JSON.stringify({ version: WHISPER_CPP_TAG, libraries: requiredLibraries.slice(1) })
    );
    assert.equal(isCompleteInstall(markerPath, binaryPath, BINARIES["win32-x64"]), false);

    fs.writeFileSync(
      markerPath,
      JSON.stringify({ version: WHISPER_CPP_TAG, libraries: requiredLibraries })
    );
    assert.equal(isCompleteInstall(markerPath, binaryPath, BINARIES["win32-x64"]), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("copyLibraries copies matching libraries from a nested extract dir", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-dll-test-"));
  const extractDir = path.join(tempDir, "extract", "nested");
  const destDir = path.join(tempDir, "bin");
  fs.mkdirSync(extractDir, { recursive: true });
  fs.mkdirSync(destDir, { recursive: true });

  const dlls = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "vcomp140.dll"];
  for (const name of [...dlls, "whisper-server-win32-x64-cpu.exe", "README.md"]) {
    fs.writeFileSync(path.join(extractDir, name), name);
  }

  try {
    const copied = copyLibraries(path.join(tempDir, "extract"), destDir, "*.dll");

    assert.deepEqual(copied.sort(), dlls.slice().sort());
    for (const name of dlls) {
      assert.ok(fs.existsSync(path.join(destDir, name)), `${name} should be copied`);
    }
    assert.ok(!fs.existsSync(path.join(destDir, "whisper-server-win32-x64-cpu.exe")));
    assert.ok(!fs.existsSync(path.join(destDir, "README.md")));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("findLibrariesInDir propagates traversal errors by default", () => {
  const missingDir = path.join(os.tmpdir(), `missing-library-dir-${process.pid}-${Date.now()}`);

  assert.throws(() => findLibrariesInDir(missingDir, "*.dll"), { code: "ENOENT" });
});

test("findLibrariesInDir supports explicit best-effort traversal", () => {
  const missingDir = path.join(os.tmpdir(), `missing-library-dir-${process.pid}-${Date.now()}`);

  assert.deepEqual(findLibrariesInDir(missingDir, "*.dll", { ignoreReadErrors: true }), []);
});

test("matchesPattern matches each supported library pattern", () => {
  assert.ok(matchesPattern("msvcp140.dll", "*.dll"));
  assert.ok(!matchesPattern("whisper-server.exe", "*.dll"));
  assert.ok(matchesPattern("libggml.dylib", "*.dylib"));
  assert.ok(!matchesPattern("libggml.dylib", "*.dll"));
  assert.ok(matchesPattern("libonnxruntime.so", "*.so*"));
  assert.ok(matchesPattern("libonnxruntime.so.1.23.2", "*.so*"));
  assert.ok(!matchesPattern("libonnxruntime.so.1.txt", "*.so*"));
});
