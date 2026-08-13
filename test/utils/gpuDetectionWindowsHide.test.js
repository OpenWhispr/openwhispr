const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Every child process gpuDetection spawns (nvidia-smi rungs, the PowerShell
// WMI fallback) must set windowsHide, or a console window flashes on Windows.
// All spawns go through the injectable execFileImpl, so the invariant is:
// each execFileImpl call site carries windowsHide: true in its options.
test("every GPU probe spawn sets windowsHide", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/utils/gpuDetection.js"), "utf8");
  const spawnSites = src.match(/execFileImpl\(/g) || [];
  const hidden = src.match(/windowsHide: true/g) || [];
  assert.ok(spawnSites.length > 0, "expected execFileImpl call sites in gpuDetection.js");
  assert.equal(hidden.length, spawnSites.length);
});
