const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  getOnnxNapiBinDir,
  getOnnxKeepArchs,
  assertOnnxruntimeBindings,
} = require("../../scripts/afterPack.js");

test("getOnnxKeepArchs keeps both arches for universal builds", () => {
  assert.deepEqual(getOnnxKeepArchs("universal"), ["arm64", "x64"]);
  assert.deepEqual(getOnnxKeepArchs("x64"), ["x64"]);
  assert.deepEqual(getOnnxKeepArchs("arm64"), ["arm64"]);
});

test("getOnnxNapiBinDir points at unpacked onnxruntime-node napi-v6", () => {
  const resourcesDir = path.join(os.tmpdir(), "openwhispr-resources");
  assert.equal(
    getOnnxNapiBinDir(resourcesDir),
    path.join(
      resourcesDir,
      "app.asar.unpacked",
      "node_modules",
      "onnxruntime-node",
      "bin",
      "napi-v6"
    )
  );
});

test("assertOnnxruntimeBindings fails closed when darwin/x64 binding is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-onnx-"));
  const onnxBinDir = path.join(tmp, "napi-v6");
  fs.mkdirSync(path.join(onnxBinDir, "darwin", "arm64"), { recursive: true });
  fs.writeFileSync(path.join(onnxBinDir, "darwin", "arm64", "onnxruntime_binding.node"), "");

  assert.throws(
    () => assertOnnxruntimeBindings(onnxBinDir, "darwin", ["x64"]),
    /darwin[/\\]x64[/\\]onnxruntime_binding\.node/
  );
});

test("assertOnnxruntimeBindings accepts present target binding", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-onnx-"));
  const onnxBinDir = path.join(tmp, "napi-v6");
  const bindingPath = path.join(onnxBinDir, "darwin", "x64", "onnxruntime_binding.node");
  fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
  fs.writeFileSync(bindingPath, "");

  assert.doesNotThrow(() => assertOnnxruntimeBindings(onnxBinDir, "darwin", ["x64"]));
});
