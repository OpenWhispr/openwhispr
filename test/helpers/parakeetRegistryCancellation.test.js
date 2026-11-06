const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

// Only offered models here: none of these tests retires one.
function registryStub(data) {
  return {
    registryData: data,
    getRunnableSpeechModel: (section, id) =>
      Object.hasOwn(data[section], id) ? data[section][id] : null,
  };
}

test("a cancellation during archive verification never installs or completes the model", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = structuredClone(require("../../src/models/modelRegistryData.json"));
  const model = Object.keys(data.parakeetModels)[0];
  data.parakeetModels[model].sha256 = "a".repeat(64);
  let entered;
  let release;
  const waiting = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const file = path.resolve(__dirname, "../../src/helpers/parakeet.js");
  const realRequire = createRequire(file);
  const stubs = {
    "../models/registryData.js": registryStub(data),
    "./debugLogger": { info() {}, warn() {}, debug() {} },
    "./modelDirUtils": { getModelsDirForService: () => root },
    "./parakeetCapability": { assertParakeetSupported() {} },
    "./parakeetServer": class {
      isModelDownloaded() {
        return false;
      }
      isAvailable() {
        return false;
      }
      getServerStatus() {
        return {};
      }
    },
    "./downloadUtils": {
      createDownloadSignal() {
        const signal = { aborted: false };
        return {
          signal,
          abort() {
            signal.aborted = true;
            signal.onAbort?.();
          },
        };
      },
      async downloadFile(_url, target) {
        fs.writeFileSync(target, "archive");
      },
      async checkDiskSpace() {
        return { ok: true };
      },
    },
    "./modelArchiveIntegrity": {
      async validateModelArchive() {
        entered();
        await gate;
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(file, "utf8"),
    {
      require: (name) => stubs[name] || realRequire(name),
      module,
      process,
      Buffer,
      console,
    },
    { filename: file }
  );
  const manager = new module.exports();
  manager.isInitialized = true;
  let extracted = false;
  manager._extractModel = async () => {
    extracted = true;
  };
  const events = [];
  const downloading = manager.downloadParakeetModel(model, (e) => events.push(e.type));
  await waiting;
  assert.equal((await manager.cancelDownload()).success, true);
  release();
  await assert.rejects(downloading, { code: "DOWNLOAD_CANCELLED" });
  assert.equal(extracted, false);
  assert.equal(events.includes("complete"), false);
  assert.equal(manager.currentDownloadProcess, null);
});

function loadManager(root, data, stubs = {}) {
  const file = path.resolve(__dirname, "../../src/helpers/parakeet.js");
  const realRequire = createRequire(file);
  const allStubs = {
    "../models/registryData.js": registryStub(data),
    "./debugLogger": { info() {}, warn() {}, debug() {} },
    "./modelDirUtils": { getModelsDirForService: () => root },
    "./parakeetCapability": {
      assertParakeetSupported() {},
      getParakeetCapability: () => ({ supported: true }),
    },
    ...stubs,
  };
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(file, "utf8"),
    { require: (name) => allStubs[name] || realRequire(name), module, process, Buffer, console },
    { filename: file }
  );
  return new module.exports();
}

test("an archive with no catalog hash still gets the structural check, with its progress", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-unhashed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = structuredClone(require("../../src/models/modelRegistryData.json"));
  const model = "parakeet-tdt-110m-en";
  assert.equal(data.parakeetModels[model].sha256, undefined);
  const manager = loadManager(root, data, {
    "./parakeetServer": class {
      isModelDownloaded() {
        return false;
      }
      isAvailable() {
        return false;
      }
      getServerStatus() {
        return {};
      }
    },
    "./downloadUtils": {
      createDownloadSignal: () => ({ signal: { aborted: false }, abort() {} }),
      async downloadFile(_url, target) {
        fs.writeFileSync(target, "archive");
      },
      async checkDiskSpace() {
        return { ok: true };
      },
    },
    "./modelArchiveIntegrity": {
      async validateModelArchive(_path, root_, _signal, _size, onProgress) {
        assert.equal(root_, data.parakeetModels[model].extractDir);
        onProgress(7);
        throw new Error("Unsafe model archive entry");
      },
    },
  });
  manager.isInitialized = true;
  let extracted = false;
  manager._extractModel = async () => {
    extracted = true;
  };
  const events = [];
  await assert.rejects(
    manager.downloadParakeetModel(model, (event) => events.push([event.type, event.percentage])),
    /Unsafe model archive entry/
  );
  assert.equal(extracted, false, "system tar never sees a refused archive");
  assert.deepEqual(events.slice(0, 2), [
    ["verifying", 0],
    ["verifying", 100],
  ]);
  assert.equal(fs.existsSync(path.join(root, `${model}.tar.bz2`)), false);
});

test("launch never pre-warms a model the catalog does not know", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-prewarm-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = structuredClone(require("../../src/models/modelRegistryData.json"));
  const offered = "parakeet-tdt-110m-en";
  const started = [];
  const manager = loadManager(root, data, {
    "./parakeetServer": class {
      hasAnyWsBinary() {
        return true;
      }
      isModelDownloaded() {
        return true;
      }
      isAvailable() {
        return true;
      }
      async startServer(model) {
        started.push(model);
      }
    },
    "./downloadUtils": { async cleanupStaleDownloads() {} },
  });
  manager.logDependencyStatus = async () => {};

  await manager.initializeAtStartup({
    localTranscriptionProvider: "nvidia",
    parakeetModel: "retired-online-model",
  });
  assert.deepEqual(started, []);

  manager.isInitialized = false;
  await manager.initializeAtStartup({
    localTranscriptionProvider: "nvidia",
    parakeetModel: offered,
  });
  assert.deepEqual(started, [offered]);
});

function archiveManager(root, data, { checkDiskSpace, validateModelArchive, policy }) {
  const signal = { aborted: false };
  const stubs = {
    "./parakeetServer": class {
      isModelDownloaded() {
        return false;
      }
      isAvailable() {
        return false;
      }
      getServerStatus() {
        return {};
      }
    },
    "./downloadUtils": {
      createDownloadSignal: () => ({
        signal,
        abort() {
          signal.aborted = true;
        },
      }),
      async downloadFile(_url, target) {
        fs.writeFileSync(target, "archive");
      },
      checkDiskSpace,
    },
    "./modelArchiveIntegrity": { validateModelArchive },
  };
  if (policy) stubs["./localModelPolicyGate"] = policy;
  const manager = loadManager(root, data, stubs);
  manager.isInitialized = true;
  manager._extractModel = async () => {};
  return manager;
}

test("an archive refused for disk space, not for itself, is kept for the next attempt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-disk-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = structuredClone(require("../../src/models/modelRegistryData.json"));
  const model = "parakeet-tdt-110m-en";
  const archive = path.join(root, `${model}.tar.bz2`);
  fs.writeFileSync(archive, "finished archive");
  const manager = archiveManager(root, data, {
    checkDiskSpace: async () => ({ ok: false, availableBytes: 0 }),
    validateModelArchive: async () => {},
  });
  await assert.rejects(manager.downloadParakeetModel(model), /Not enough disk space/);
  assert.equal(fs.existsSync(archive), true);
});

test("a revocation during the archive check keeps the finished archive", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-revoke-verify-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = structuredClone(require("../../src/models/modelRegistryData.json"));
  const model = "parakeet-tdt-110m-en";
  let revoked = false;
  let abortDownload;
  const refusal = () => Object.assign(new Error("blocked"), { code: "POLICY_MODEL_BLOCKED" });
  const manager = archiveManager(root, data, {
    checkDiskSpace: async () => ({ ok: true }),
    validateModelArchive: async () => {
      revoked = true;
      abortDownload();
      throw Object.assign(new Error("Verification cancelled"), { isAbort: true });
    },
    policy: {
      runLocalModelOperation: (_owner, _scope, _model, run) => run(),
      isLocalModelPolicyRefusal: (error) => error?.code === "POLICY_MODEL_BLOCKED",
      assertLocalModelOperation() {
        if (revoked) throw refusal();
      },
      localModelOperationSignal: (_owner, signal) => signal,
      bindLocalModelDownload(_owner, abort) {
        abortDownload = abort;
        return () => {};
      },
    },
  });
  await assert.rejects(manager.downloadParakeetModel(model), { code: "POLICY_MODEL_BLOCKED" });
  assert.equal(fs.existsSync(path.join(root, `${model}.tar.bz2`)), true);
});
