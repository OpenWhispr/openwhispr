const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("nvidia-smi GPU probes set windowsHide", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/utils/gpuDetection.js"), "utf8");
  const hidden = src.match(/execFile\(\s*"nvidia-smi"[^{}]*\{[^{}]*windowsHide: true/g) || [];
  assert.equal(hidden.length, 2);
});
