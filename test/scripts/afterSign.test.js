const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildPeImage } = require("../helpers/harness/peFixture");
const afterSign = require("../../scripts/afterSign");

const signed = () => buildPeImage({ signed: true });
const unsigned = () => buildPeImage();

function makeAppDir(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aftersign-app-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return dir;
}

function buildContext(appOutDir, { platform = "win32", forceCodeSigning = true } = {}) {
  return { electronPlatformName: platform, appOutDir, packager: { forceCodeSigning } };
}

test("lists unsigned .exe, .dll and .node files at any depth, ignoring extension case", (t) => {
  const sqliteBinding = path.join(
    "resources",
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node"
  );
  const dir = makeAppDir(t, {
    "OpenWhispr.exe": signed(),
    "ffmpeg.dll": unsigned(),
    [sqliteBinding]: unsigned(),
    "resources/bin/Helper.DLL": unsigned(),
    "resources/bin/nircmd.exe": unsigned(),
    "resources/bin/ow-onnxrt.dll": signed(),
    "resources/app.asar": "not a PE image",
    "locales/en-US.pak": "not a PE image",
  });

  assert.deepEqual(afterSign.findUnsignedBinaries(dir), [
    "ffmpeg.dll",
    sqliteBinding,
    path.join("resources", "bin", "Helper.DLL"),
    path.join("resources", "bin", "nircmd.exe"),
  ]);
});

test("reads the signature from the headers of a binary larger than the header read", (t) => {
  const dir = makeAppDir(t, {
    "OpenWhispr.exe": Buffer.concat([signed(), Buffer.alloc(256 * 1024)]),
  });
  assert.deepEqual(afterSign.findUnsignedBinaries(dir), []);
});

test("fails a signed Windows build that would ship an unsigned binary", async (t) => {
  const dir = makeAppDir(t, {
    "OpenWhispr.exe": signed(),
    "resources/bin/nircmd.exe": unsigned(),
  });
  await assert.rejects(
    afterSign.default(buildContext(dir)),
    /unsigned Windows binaries[\s\S]*nircmd\.exe/
  );
});

test("passes a signed Windows build where every binary is signed", async (t) => {
  const dir = makeAppDir(t, {
    "OpenWhispr.exe": signed(),
    "resources/bin/ow-onnxrt.dll": signed(),
  });
  await assert.doesNotReject(afterSign.default(buildContext(dir)));
});

test("skips unsigned Windows builds and other platforms", async (t) => {
  const dir = makeAppDir(t, { "OpenWhispr.exe": unsigned() });
  await assert.doesNotReject(afterSign.default(buildContext(dir, { forceCodeSigning: false })));
  await assert.doesNotReject(afterSign.default(buildContext(dir, { platform: "darwin" })));
  await assert.doesNotReject(afterSign.default(buildContext(dir, { platform: "linux" })));
});
