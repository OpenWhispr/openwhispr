const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { verifyWhisperServerFallbackBuilds } = require("../../scripts/afterPack");

// A win32-x64 platform with a build for processors without AVX2, as
// download-whisper-cpp.js lists it once the pinned release ships it (#2356)
const binaries = {
  "win32-x64": { platformArch: "win32-x64", outputName: "whisper-server-win32-x64.exe" },
  "win32-x64-ivybridge": {
    platformArch: "win32-x64",
    outputName: "whisper-server-win32-x64-ivybridge.exe",
  },
  "linux-x64": { platformArch: "linux-x64", outputName: "whisper-server-linux-x64" },
};

function makeBinDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of files) fs.writeFileSync(path.join(dir, name), "");
  return dir;
}

test("passes when every build for processors without AVX2 listed for the platform ships", (t) => {
  const dir = makeBinDir(t, [
    "whisper-server-win32-x64.exe",
    "whisper-server-win32-x64-ivybridge.exe",
  ]);
  assert.doesNotThrow(() => verifyWhisperServerFallbackBuilds(dir, "win32-x64", binaries));
});

test("fails when a listed build for processors without AVX2 is missing", (t) => {
  const dir = makeBinDir(t, ["whisper-server-win32-x64.exe"]);
  assert.throws(
    () => verifyWhisperServerFallbackBuilds(dir, "win32-x64", binaries),
    /missing whisper-server-win32-x64-ivybridge\.exe/
  );
});

test("leaves the primary build to the download step", (t) => {
  const dir = makeBinDir(t, ["whisper-server-win32-x64-ivybridge.exe"]);
  assert.doesNotThrow(() => verifyWhisperServerFallbackBuilds(dir, "win32-x64", binaries));
  assert.doesNotThrow(() => verifyWhisperServerFallbackBuilds(dir, "linux-x64", binaries));
});
