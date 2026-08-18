const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Runs outside Electron: stub the app userData path before loading the module.
let userDataDir = null;

require.cache[require.resolve("electron")] = {
  exports: { app: { getPath: () => userDataDir } },
};

const notice = require("../../src/helpers/gpuPackMigrationNotice.js");

test.beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpu-notice-test-"));
});

test.afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

test("record/read/clear round-trip", () => {
  assert.equal(notice.read(), null);

  notice.record(["CUDA whisper", "Vulkan llama"]);
  assert.deepEqual(notice.read(), { packs: ["CUDA whisper", "Vulkan llama"] });

  notice.clear();
  assert.equal(notice.read(), null);
});

test("recording again merges and dedupes instead of overwriting", () => {
  notice.record(["CUDA whisper"]);
  notice.record(["CUDA whisper", "Vulkan llama"]);

  assert.deepEqual(notice.read(), { packs: ["CUDA whisper", "Vulkan llama"] });
});

test("empty recordings and corrupt sentinels read as no notice", () => {
  notice.record([]);
  assert.equal(notice.read(), null);

  fs.writeFileSync(path.join(userDataDir, ".gpu-pack-migration-notice"), "not json");
  assert.equal(notice.read(), null);
});
