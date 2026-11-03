const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { performance } = require("node:perf_hooks");
const { validateModelArchive } = require("../../src/helpers/modelArchiveIntegrity");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-responsive-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archivePath = path.join(dir, "model.tar.bz2");
  fs.writeFileSync(
    archivePath,
    Buffer.from(require("../fixtures/large-model-archive.json").base64, "base64")
  );
  return { dir, archivePath };
}

async function assertResponsive(operation) {
  let last = performance.now();
  let maxDelay = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxDelay = Math.max(maxDelay, now - last);
    last = now;
    ticks++;
  }, 10);
  try {
    await operation();
    maxDelay = Math.max(maxDelay, performance.now() - last);
    assert.ok(ticks > 0, "archive work must yield to the event loop");
    assert.ok(maxDelay < 250, `archive work blocked the event loop for ${maxDelay.toFixed(0)}ms`);
  } finally {
    clearInterval(timer);
  }
}

test("complete bzip2 archive verification keeps the main event loop responsive", async (t) => {
  const { archivePath } = fixture(t);
  await assertResponsive(() => validateModelArchive(archivePath, "root"));
});

test("JavaScript bzip2 fallback extraction keeps the main event loop responsive", async (t) => {
  const { archivePath, dir } = fixture(t);
  const file = path.resolve(__dirname, "../../src/helpers/parakeet.js");
  const realRequire = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(file, "utf8"),
    {
      require(name) {
        if (name === "./downloadUtils") return {};
        if (name === "./parakeetServer") return class {};
        if (name === "./debugLogger") return { debug() {} };
        if (name === "./modelDirUtils" || name === "./parakeetCapability") return {};
        return realRequire(name);
      },
      module,
      process,
      Buffer,
      console,
    },
    { filename: file }
  );
  const manager = new module.exports();
  manager._runSystemTar = async () => {
    throw new Error("Native tar unavailable");
  };
  await assertResponsive(() => manager._runTarExtract(archivePath, dir));
  assert.equal(fs.statSync(path.join(dir, "root/weights.bin")).size, 64 * 1024 * 1024);
});

test("missing and corrupt archives reject instead of reporting successful verification", async (t) => {
  const { archivePath } = fixture(t);
  fs.unlinkSync(archivePath);
  await assert.rejects(validateModelArchive(archivePath, "root"), /ENOENT/);
  fs.writeFileSync(archivePath, "not a bzip2 archive");
  await assert.rejects(validateModelArchive(archivePath, "root"));
});
