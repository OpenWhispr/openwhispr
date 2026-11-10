const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildPeImage } = require("../helpers/harness/peFixture");
const { listImportedModules } = require("../../scripts/lib/pe-imports");
const {
  privatizeInstalledSherpaNode,
  privatizeOnnxRuntimeDir,
  verifyOnnxRuntimePrivatizedDir,
} = require("../../scripts/download-sherpa-onnx");

function sherpaDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sherpa-win-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "onnxruntime.dll"), buildPeImage({ imports: ["KERNEL32.dll"] }));
  fs.writeFileSync(
    path.join(dir, "sherpa-onnx-c-api.dll"),
    buildPeImage({ imports: ["KERNEL32.dll", "onnxruntime.dll"] })
  );
  fs.writeFileSync(
    path.join(dir, "sherpa-onnx.node"),
    buildPeImage({ imports: ["sherpa-onnx-c-api.dll"], delayImports: ["onnxruntime.dll"] })
  );
  fs.writeFileSync(path.join(dir, "index.js"), "module.exports = {};");
  return dir;
}

const snapshot = (dir) =>
  Object.fromEntries(
    fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name))])
  );

test("renames the runtime and re-points every importer", (t) => {
  const dir = sherpaDir(t);
  privatizeOnnxRuntimeDir(dir);

  assert.equal(fs.existsSync(path.join(dir, "onnxruntime.dll")), false);
  assert.equal(fs.existsSync(path.join(dir, "ow-onnxrt.dll")), true);
  assert.deepEqual(listImportedModules(fs.readFileSync(path.join(dir, "sherpa-onnx.node"))), [
    "sherpa-onnx-c-api.dll",
    "ow-onnxrt.dll",
  ]);
  assert.deepEqual(listImportedModules(fs.readFileSync(path.join(dir, "sherpa-onnx-c-api.dll"))), [
    "KERNEL32.dll",
    "ow-onnxrt.dll",
  ]);
  assert.doesNotThrow(() => verifyOnnxRuntimePrivatizedDir(dir));
});

test("an already privatized package passes again unchanged", (t) => {
  const dir = sherpaDir(t);
  privatizeOnnxRuntimeDir(dir);
  const before = snapshot(dir);

  privatizeOnnxRuntimeDir(dir);

  assert.deepEqual(snapshot(dir), before);
  assert.doesNotThrow(() => verifyOnnxRuntimePrivatizedDir(dir));
});

test("a package without either runtime name fails loudly", (t) => {
  const dir = sherpaDir(t);
  fs.rmSync(path.join(dir, "onnxruntime.dll"));

  assert.throws(() => privatizeOnnxRuntimeDir(dir), /onnxruntime\.dll not found/);
  assert.throws(() => verifyOnnxRuntimePrivatizedDir(dir), /has no ow-onnxrt\.dll/);
});

test("verification fails while any image still imports onnxruntime.dll", (t) => {
  const dir = sherpaDir(t);
  fs.renameSync(path.join(dir, "onnxruntime.dll"), path.join(dir, "ow-onnxrt.dll"));
  assert.throws(
    () => verifyOnnxRuntimePrivatizedDir(dir),
    /sherpa-onnx-c-api\.dll still imports onnxruntime\.dll/
  );
});

test("verification fails while onnxruntime.dll would still ship", (t) => {
  const dir = sherpaDir(t);
  privatizeOnnxRuntimeDir(dir);
  fs.writeFileSync(path.join(dir, "onnxruntime.dll"), buildPeImage({ imports: ["KERNEL32.dll"] }));
  assert.throws(() => verifyOnnxRuntimePrivatizedDir(dir), /onnxruntime\.dll must not ship/);
});

test("npm run dev on Windows renames the runtime in the installed sherpa-onnx package", (t) => {
  const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "sherpa-modules-"));
  t.after(() => fs.rmSync(modulesDir, { recursive: true, force: true }));
  const installed = path.join(modulesDir, "sherpa-onnx-win-x64");
  fs.cpSync(sherpaDir(t), installed, { recursive: true });

  privatizeInstalledSherpaNode("darwin-arm64", modulesDir);
  assert.equal(fs.existsSync(path.join(installed, "onnxruntime.dll")), true, "only on Windows");

  privatizeInstalledSherpaNode("win32-x64", modulesDir);
  assert.doesNotThrow(() => verifyOnnxRuntimePrivatizedDir(installed));
  // Nothing installed for this arch: nothing to do.
  assert.doesNotThrow(() => privatizeInstalledSherpaNode("win32-arm64", modulesDir));
});
