const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// debugLogger writes no file at the default level, so GPU fallback warnings
// keep a small log of their own that a support request can point at (#2554).

const modulePath = require.resolve("../../src/helpers/gpuFallbackLog");
const originalLoad = Module._load;
const warned = [];
let userDataDir;

Module._load = function loadWithStubs(request, parent, isMain) {
  if (parent?.filename === modulePath && request === "electron") {
    return { app: { getPath: () => userDataDir, getVersion: () => "9.9.9" } };
  }
  if (parent?.filename === modulePath && request === "./debugLogger") {
    return { warn: (message, meta) => warned.push({ message, meta }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// A fresh module stands for a new launch.
function launch() {
  delete require.cache[modulePath];
  return require(modulePath);
}

function logLines() {
  return fs
    .readFileSync(path.join(userDataDir, "logs", "gpu-fallback.log"), "utf8")
    .trim()
    .split("\n");
}

test.beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-fallback-log-"));
  warned.length = 0;
});

test.afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test.after(() => {
  Module._load = originalLoad;
});

test("a warning goes to debugLogger and to the GPU log at any level", () => {
  const { warnGpuFallback } = launch();
  warnGpuFallback("Whisper CUDA enabled but cannot be used", { reason: "pack needs update" });

  assert.deepEqual(warned, [
    { message: "Whisper CUDA enabled but cannot be used", meta: { reason: "pack needs update" } },
  ]);
  const [line] = logLines();
  assert.match(line, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[9\.9\.9\] Whisper CUDA enabled/);
  assert.match(line, /\{"reason":"pack needs update"\}$/);
});

test("a launch appends its warnings and the next launch replaces them", () => {
  const first = launch();
  first.warnGpuFallback("first", { n: 1 });
  first.warnGpuFallback("second", { n: 2 });
  assert.equal(logLines().length, 2);

  launch().warnGpuFallback("next launch", { n: 3 });
  const lines = logLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /next launch/);
});

test("a log that can't be written still leaves the debugLogger warning", () => {
  fs.writeFileSync(path.join(userDataDir, "logs"), "a file where the folder should be");
  const { warnGpuFallback } = launch();

  assert.doesNotThrow(() => warnGpuFallback("unwritable", {}));
  assert.equal(warned.length, 1);
});
