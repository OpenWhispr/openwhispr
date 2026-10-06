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

test("recordOnce fires each pack's notice only once, surviving a dismissal", () => {
  notice.recordOnce(["CUDA whisper"]);
  assert.deepEqual(notice.read(), { packs: ["CUDA whisper"] });

  // Toast shown and dismissed; the pack is still missing on the next launch
  notice.clear();
  notice.recordOnce(["CUDA whisper"]);
  assert.equal(notice.read(), null);

  // A pack orphaned later still gets its one notice
  notice.recordOnce(["CUDA whisper", "Vulkan whisper"]);
  assert.deepEqual(notice.read(), { packs: ["Vulkan whisper"] });
});

test("recordOnce does not re-record a pack already noticed via record", () => {
  notice.record(["CUDA whisper"]);
  notice.recordOnce(["CUDA whisper"]);
  assert.deepEqual(notice.read(), { packs: ["CUDA whisper"] });

  notice.clear();
  notice.recordOnce(["CUDA whisper"]);
  assert.equal(notice.read(), null);
});

test("recordOnce with an occasion notices again per occasion, apart from the orphan notice", () => {
  // Already told once as an orphan (e.g. by the 1.8.3 migration)
  notice.recordOnce(["CUDA whisper"]);
  notice.clear();

  // An update makes the pack unusable: that still gets its notice
  notice.recordOnce(["CUDA whisper"], "outdated-1.10.0");
  assert.deepEqual(notice.read(), { packs: ["CUDA whisper"] });

  // Once per occasion, surviving a dismissal
  notice.clear();
  notice.recordOnce(["CUDA whisper"], "outdated-1.10.0");
  assert.equal(notice.read(), null);

  // The next version tells the user again while the pack is still unusable
  notice.recordOnce(["CUDA whisper"], "outdated-1.10.1");
  assert.deepEqual(notice.read(), { packs: ["CUDA whisper"] });

  // The plain orphan notice keeps its own once
  notice.clear();
  notice.recordOnce(["CUDA whisper"]);
  assert.equal(notice.read(), null);
});

test("empty recordings and corrupt sentinels read as no notice", () => {
  notice.record([]);
  assert.equal(notice.read(), null);

  fs.writeFileSync(path.join(userDataDir, ".gpu-pack-migration-notice"), "not json");
  assert.equal(notice.read(), null);
});
