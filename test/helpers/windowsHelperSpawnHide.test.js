const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

function read(rel) {
  return fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");
}

function hiddenSpawnCount(src) {
  return (src.match(/spawn\([^{}]*\{[^{}]*windowsHide: true/g) || []).length;
}

test("meeting AEC helper spawn sets windowsHide", () => {
  assert.equal(hiddenSpawnCount(read("src/helpers/meetingAecManager.js")), 1);
});

test("text edit monitor spawns set windowsHide", () => {
  assert.equal(hiddenSpawnCount(read("src/helpers/textEditMonitor.js")), 2);
});

test("Windows mic-listener spawn sets windowsHide", () => {
  assert.match(
    read("src/helpers/audioActivityDetector.js"),
    /spawn\(binaryPath, \["--exclude-pid"[^{}]*\{[^{}]*windowsHide: true/
  );
});
