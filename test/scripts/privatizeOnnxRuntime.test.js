const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildPeImage } = require("../helpers/harness/peFixture");
const { listImportedModules } = require("../../scripts/lib/pe-imports");
const {
  privatizeOnnxRuntimeDir,
  verifyOnnxRuntimePrivatizedDir,
} = require("../../scripts/lib/privatize-onnxruntime");

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

test("renames the runtime and re-points every importer", (t) => {
  const dir = sherpaDir(t);
  const result = privatizeOnnxRuntimeDir(dir);

  assert.equal(result.renamed, true);
  assert.deepEqual(result.patched.sort(), ["sherpa-onnx-c-api.dll", "sherpa-onnx.node"]);
  assert.equal(fs.existsSync(path.join(dir, "onnxruntime.dll")), false);
  assert.equal(fs.existsSync(path.join(dir, "ow-onnxrt.dll")), true);
  assert.deepEqual(listImportedModules(fs.readFileSync(path.join(dir, "sherpa-onnx.node"))), [
    "sherpa-onnx-c-api.dll",
    "ow-onnxrt.dll",
  ]);
  assert.doesNotThrow(() => verifyOnnxRuntimePrivatizedDir(dir));
});

test("running twice changes nothing the second time", (t) => {
  const dir = sherpaDir(t);
  privatizeOnnxRuntimeDir(dir);
  assert.deepEqual(privatizeOnnxRuntimeDir(dir), { renamed: false, patched: [] });
});

test("verification fails while any image still imports onnxruntime.dll", (t) => {
  const dir = sherpaDir(t);
  assert.throws(() => verifyOnnxRuntimePrivatizedDir(dir), /onnxruntime\.dll/);
});
