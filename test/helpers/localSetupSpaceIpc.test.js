const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The model managers read Electron at module scope; give them a stub so their
// exported disk-space factors can be loaded outside Electron.
const electronHome = fs.mkdtempSync(path.join(os.tmpdir(), "local-setup-space-home-"));
const originalLoad = Module._load;
Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        isReady: () => true,
        getAppPath: () => process.cwd(),
        getPath: (name) => (name === "home" ? electronHome : path.join(electronHome, name)),
      },
      net: {},
      ipcMain: { handle() {}, on() {} },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
test.after(() => {
  Module._load = originalLoad;
  fs.rmSync(electronHome, { recursive: true, force: true });
});

const helpers = path.resolve(__dirname, "../../src/helpers");
const downloadUtils = require(path.join(helpers, "downloadUtils"));

function freshRoot(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "local-setup-space-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return path.join(base, ".cache", "openwhispr");
}

test("the handler returns the four exported factors", async (t) => {
  const { readLocalSetupSpace } = require(path.join(helpers, "localSetupSpace"));
  const { factors } = await readLocalSetupSpace({ getCacheRoot: () => freshRoot(t) });

  const { WHISPER_DISK_SPACE_FACTOR } = require(path.join(helpers, "whisper"));
  const { PARAKEET_DISK_SPACE_FACTOR } = require(path.join(helpers, "parakeet"));
  const { LLM_DISK_SPACE_FACTOR } = require(path.join(helpers, "modelManagerBridge"));
  const { DISK_SPACE_MULTIPLIER } = require(path.join(helpers, "gpuBinaryManager"));
  assert.deepEqual(factors, {
    whisper: WHISPER_DISK_SPACE_FACTOR,
    parakeet: PARAKEET_DISK_SPACE_FACTOR,
    llm: LLM_DISK_SPACE_FACTOR,
    llamaVulkan: DISK_SPACE_MULTIPLIER,
  });
  // The figures the download paths check today (global call 3).
  assert.deepEqual(factors, { whisper: 1.2, parakeet: 2.5, llm: 1.2, llamaVulkan: 2.5 });
});

test("the download checks use the exported factors, not their own literals", () => {
  const read = (file) => fs.readFileSync(path.join(helpers, file), "utf8");
  const sizeCheck = (factor) =>
    new RegExp(`checkDiskSpace\\(\\s*modelsDir,\\s*modelConfig\\.size \\* ${factor}\\s*\\)`);
  const checks = {
    "whisper.js": sizeCheck("WHISPER_DISK_SPACE_FACTOR"),
    "parakeet.js": sizeCheck("PARAKEET_DISK_SPACE_FACTOR"),
    "modelManagerBridge.js": /set\(modelId, requiredBytes \* LLM_DISK_SPACE_FACTOR\)/,
    "gpuBinaryManager.js": /\* DISK_SPACE_MULTIPLIER;/,
  };
  for (const [file, pattern] of Object.entries(checks)) {
    assert.match(read(file), pattern, file);
  }
});

test("a fresh install reads the real disk, not the missing-folder fallback", async (t) => {
  const root = freshRoot(t);
  // checkDiskSpace reports Infinity for a folder that does not exist yet.
  assert.equal((await downloadUtils.checkDiskSpace(root, 0)).availableBytes, Infinity);

  const { readLocalSetupSpace } = require(path.join(helpers, "localSetupSpace"));
  const calls = [];
  const space = await readLocalSetupSpace({
    getCacheRoot: () => root,
    async checkDiskSpace(dir, required) {
      calls.push({ dir, required, existed: fs.existsSync(dir) });
      return downloadUtils.checkDiskSpace(dir, required);
    },
  });

  assert.deepEqual(calls, [{ dir: root, required: 0, existed: true }]);
  assert.ok(Number.isFinite(space.availableBytes) && space.availableBytes > 0);
});

test("get-local-setup-space is registered and exposed to the renderer", () => {
  const ipc = fs.readFileSync(path.join(helpers, "ipcHandlers.js"), "utf8");
  assert.match(ipc, /ipcMain\.handle\("get-local-setup-space", \(\) => readLocalSetupSpace\(\)\)/);
  const preload = fs.readFileSync(path.resolve(__dirname, "../../preload.js"), "utf8");
  assert.match(
    preload,
    /getLocalSetupSpace: \(\) => ipcRenderer\.invoke\("get-local-setup-space"\)/
  );
});
