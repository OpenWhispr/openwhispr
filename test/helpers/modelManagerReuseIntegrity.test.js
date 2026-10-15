const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");

const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
const digest = (data) => createHash("sha256").update(data).digest("hex");

function loadSource(relativePath, stubs) {
  const filename = path.resolve(__dirname, "../../src/helpers", relativePath);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      require: (name) => (Object.hasOwn(stubs, name) ? stubs[name] : realRequire(name)),
      module,
      process,
      console,
      Buffer,
      setTimeout,
      clearTimeout,
    },
    { filename }
  );
  return module.exports;
}

function setup(t, { sha256 = digest(bytes), draft = false, onRead } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-reuse-integrity-"));
  fs.mkdirSync(path.join(root, "models"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const model = {
    id: "reuse-fixture",
    fileName: "fixture.gguf",
    sha256,
    sizeBytes: bytes.length,
    ...(draft
      ? {
          draftFileName: "draft.gguf",
          draftHfRepo: "fixture/draft",
          draftSizeBytes: bytes.length,
          draftSha256: digest(bytes),
        }
      : {}),
  };
  const electron = { app: { isReady: () => true }, net: { request: assert.fail } };
  const logger = { info() {}, warn() {}, error() {} };
  const utils = loadSource("downloadUtils.js", {
    electron,
    "./debugLogger": logger,
    ...(onRead
      ? {
          fs: {
            ...fs,
            createReadStream(filePath) {
              const stream = fs.createReadStream(filePath);
              stream.once("data", () => onRead(stream));
              return stream;
            },
          },
        }
      : {}),
  });
  const manager = loadSource("modelManagerBridge.js", {
    electron,
    "./downloadUtils": {
      ...utils,
      checkDiskSpace: () => assert.fail("Reuse must not reserve disk space"),
    },
    "./debugLogger": logger,
    "./llamaServer": class {},
    "../models/registryData.js": {
      registryData: { localProviders: [{ id: "fixture", models: [model] }] },
    },
    "./modelDirUtils": { getCacheRoot: () => root },
  }).default;
  const finalPath = path.join(root, "models", model.fileName);
  fs.writeFileSync(finalPath, bytes);
  return { manager, model, finalPath };
}

function assertSettled(manager) {
  for (const name of [
    "activeDownloads",
    "activeRequests",
    "downloadProgress",
    "downloadReservations",
  ]) {
    assert.equal(manager[name].size, 0, `${name} must settle`);
  }
}

test("explicit reuse verifies matching existing bytes without network or disk reservation", async (t) => {
  const { manager, model, finalPath } = setup(t);
  assert.equal(await manager.downloadModel(model.id), finalPath);
  assertSettled(manager);
});

test("explicit reuse rejects same-size corruption and preserves the existing artifact", async (t) => {
  const { manager, model, finalPath } = setup(t);
  const corrupt = Buffer.from(bytes);
  corrupt[4096] ^= 1;
  fs.writeFileSync(finalPath, corrupt);
  // Presence/status remains a lightweight check, not continuous attestation.
  assert.equal(await manager.isModelDownloaded(model.id), true);
  await assert.rejects(manager.downloadModel(model.id), { code: "DOWNLOAD_CORRUPTED" });
  assert.deepEqual(fs.readFileSync(finalPath), corrupt);
  assert.equal(fs.existsSync(`${finalPath}.tmp`), false);
  assertSettled(manager);
  fs.writeFileSync(finalPath, bytes);
  assert.equal(await manager.downloadModel(model.id), finalPath);
  assertSettled(manager);
});

test("an artifact replaced after successful reuse is verified again", async (t) => {
  const { manager, model, finalPath } = setup(t);
  await manager.downloadModel(model.id);
  const replacement = path.join(path.dirname(finalPath), "replacement.gguf");
  fs.writeFileSync(replacement, Buffer.alloc(bytes.length, 8));
  fs.renameSync(replacement, finalPath);
  await assert.rejects(manager.downloadModel(model.id), { code: "DOWNLOAD_CORRUPTED" });
  assertSettled(manager);
});

test("cancellation during streamed verification retains ownership until settled and permits retry", async (t) => {
  let cancel = true;
  let observedStream;
  let duplicate;
  const { manager, model, finalPath } = setup(t, {
    onRead(stream) {
      if (!cancel) return;
      cancel = false;
      observedStream = stream;
      duplicate = assert.rejects(manager.downloadModel(model.id), { code: "DOWNLOAD_IN_PROGRESS" });
      assert.equal(manager.cancelDownload(model.id), true);
      assert.equal(manager.activeDownloads.has(model.id), true);
    },
  });
  await assert.rejects(manager.downloadModel(model.id), { code: "DOWNLOAD_CANCELLED" });
  await duplicate;
  assert.ok(observedStream.closed, "verification closes the reader before releasing ownership");
  assert.deepEqual(fs.readFileSync(finalPath), bytes);
  assertSettled(manager);
  assert.equal(await manager.downloadModel(model.id), finalPath);
  assertSettled(manager);
});

test("duplicate reuse requests cannot steal an operation still checking the final path", async (t) => {
  const { manager, model, finalPath } = setup(t);
  const originalCheck = manager.checkModelValid.bind(manager);
  const gate = Promise.withResolvers();
  manager.checkModelValid = async (filePath) => {
    await gate.promise;
    return originalCheck(filePath);
  };
  const owner = manager.downloadModel(model.id);
  try {
    await assert.rejects(manager.downloadModel(model.id), { code: "DOWNLOAD_IN_PROGRESS" });
    assert.equal(manager.activeDownloads.has(model.id), true);
  } finally {
    gate.resolve();
    await owner;
  }
  assert.equal(await owner, finalPath);
  assertSettled(manager);
});

test("legacy unhashed existing models remain reusable", async (t) => {
  const { manager, model, finalPath } = setup(t, { sha256: null });
  assert.equal(await manager.downloadModel(model.id), finalPath);
  assertSettled(manager);
});

for (const installedDraft of [false, true]) {
  test(`a verified existing main remains reusable with ${installedDraft ? "unverified" : "missing"} optional drafter`, async (t) => {
    const { manager, model, finalPath } = setup(t, { draft: true });
    if (installedDraft) {
      fs.writeFileSync(
        path.join(path.dirname(finalPath), model.draftFileName),
        Buffer.alloc(bytes.length, 8)
      );
    }
    assert.equal(await manager.downloadModel(model.id), finalPath);
    assertSettled(manager);
  });
}
