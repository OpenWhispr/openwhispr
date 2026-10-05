const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { verifyWindowsOnnxRuntimePrivatized } = require("../../scripts/afterPack");

function makeBinDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afterpack-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("passes when only the private ONNX Runtime is present", (t) => {
  const dir = makeBinDir(t);
  fs.writeFileSync(path.join(dir, "ow-onnxrt.dll"), "");
  assert.doesNotThrow(() => verifyWindowsOnnxRuntimePrivatized(dir));
});

test("fails when a stray onnxruntime.dll would ship", (t) => {
  const dir = makeBinDir(t);
  fs.writeFileSync(path.join(dir, "ow-onnxrt.dll"), "");
  fs.writeFileSync(path.join(dir, "onnxruntime.dll"), "");
  assert.throws(() => verifyWindowsOnnxRuntimePrivatized(dir), /onnxruntime\.dll must not ship/);
});

test("fails when the private ONNX Runtime is missing", (t) => {
  const dir = makeBinDir(t);
  assert.throws(() => verifyWindowsOnnxRuntimePrivatized(dir), /missing .*ow-onnxrt\.dll/);
});
