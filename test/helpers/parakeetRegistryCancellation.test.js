const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

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
    "../models/registryData.js": { registryData: data },
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
