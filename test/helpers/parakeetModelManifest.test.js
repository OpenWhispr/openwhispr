const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const registry = require("../../src/models/modelRegistryData.json");
const { getRequiredModelFiles } = require("../../src/helpers/parakeetModelInfo");

const MODEL = "orukeet-v0.1.0";
const info = registry.parakeetModels[MODEL];
const manifest = {
  archive: path.posix.basename(new URL(info.downloadUrl).pathname),
  extract_dir: info.extractDir,
  archive_bytes: info.expectedSizeBytes,
  archive_sha256: "a".repeat(64),
};
const managerFile = path.resolve(__dirname, "../../src/helpers/parakeet.js");

function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parakeet-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = { downloads: [], manifests: [], events: [], errors: [], warms: 0 };
  const realRequire = createRequire(managerFile);
  const timeout = new AbortController();
  const fakeFs = options.writeError
    ? {
        ...fs,
        promises: {
          ...fs.promises,
          writeFile: async () => {
            throw new Error("disk full");
          },
        },
      }
    : fs;
  const stubs = {
    fs: fakeFs,
    electron: {
      net: {
        fetch: async (url, init) => {
          calls.manifests.push({ url, init });
          calls.events.push("manifest");
          return options.fetch ? options.fetch(url, init) : Response.json(manifest);
        },
      },
    },
    "./debugLogger": {
      info() {},
      warn() {},
      debug(message, data) {
        if (message === "Optional model manifest unavailable") calls.errors.push(data);
      },
    },
    "./modelDirUtils": { getModelsDirForService: () => root },
    "./parakeetCapability": { assertParakeetSupported() {} },
    "./parakeetServer": class {
      isModelDownloaded(name) {
        return fs.existsSync(path.join(root, name, "tokens.txt"));
      }
      getServerStatus() {
        return { running: !!options.running, starting: false };
      }
      isAvailable() {
        return true;
      }
      async startServer() {
        calls.warms++;
        calls.events.push("warm");
      }
    },
    "./downloadUtils": {
      async downloadFile(url, target, { signal }) {
        calls.downloads.push(url);
        if (options.cancel) {
          signal.aborted = true;
          throw Object.assign(new Error("cancelled"), { isAbort: true });
        }
        if (options.downloadError) throw new Error("download failed");
        fs.writeFileSync(target, "archive fixture");
        calls.events.push("downloaded");
      },
      createDownloadSignal() {
        const signal = { aborted: false };
        return {
          signal,
          abort: () => {
            signal.aborted = true;
          },
        };
      },
      createDownloadInProgressError: () => new Error("download already running"),
      checkDiskSpace: async () => ({ ok: true }),
    },
  };
  const exports = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(managerFile, "utf8"),
    {
      require: (name) => stubs[name] || realRequire(name),
      module: exports,
      URL,
      AbortSignal: {
        timeout(ms) {
          assert.equal(ms, 3000);
          return timeout.signal;
        },
      },
      process,
      Buffer,
      console,
    },
    { filename: managerFile }
  );
  const manager = new exports.exports();
  let extracts = 0;
  manager._runTarExtract = async (_archive, destination) => {
    extracts++;
    if (options.extractionError || (options.retryExtraction && extracts === 1))
      throw new Error("bad archive");
    const name = options.model || MODEL;
    const dir = path.join(destination, registry.parakeetModels[name].extractDir);
    fs.mkdirSync(dir, { recursive: true });
    for (const file of getRequiredModelFiles(name))
      fs.writeFileSync(path.join(dir, file), "model fixture");
    calls.events.push("extracted");
  };
  let manifestTask;
  const save = manager._saveModelManifest.bind(manager);
  manager._saveModelManifest = (...args) => {
    manifestTask = save(...args);
    return manifestTask;
  };
  return {
    manager,
    root,
    calls,
    timeout,
    sidecar: path.join(root, MODEL, "download-manifest.json"),
    async settled() {
      await manifestTask?.catch(() => {});
    },
  };
}

test("Orukeet manifest is pinned beside its existing archive; other models are not opted in", () => {
  assert.equal(info.manifestUrl, new URL("manifest.json", info.downloadUrl).href);
  assert.match(info.manifestUrl, /\/resolve\/[a-f0-9]{40}\/onnx\/manifest\.json$/);
  assert.deepEqual(
    Object.keys(registry.parakeetModels).filter((id) => registry.parakeetModels[id].manifestUrl),
    [MODEL]
  );
});

test("fresh install fetches one manifest after extraction and warmup, then saves optional provenance", async (t) => {
  const h = setup(t);
  assert.equal((await h.manager.downloadParakeetModel(MODEL)).success, true);
  await h.settled();
  assert.deepEqual(h.calls.events, ["downloaded", "extracted", "warm", "manifest"]);
  assert.equal(h.calls.manifests.length, 1);
  const { url, init } = h.calls.manifests[0];
  assert.equal(url, info.manifestUrl);
  assert.equal(init.credentials, "omit");
  assert.equal(init.useSessionCookies, false);
  assert.equal(init.cache, "no-store");
  assert.equal(h.manager.currentDownloadProcess, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(h.sidecar)), manifest);
  for (const file of getRequiredModelFiles(MODEL))
    assert.equal(fs.readFileSync(path.join(h.root, MODEL, file), "utf8"), "model fixture");
  await h.manager.downloadParakeetModel(MODEL);
  assert.equal(h.calls.manifests.length, 1);
  assert.equal(h.calls.downloads.length, 1);
});

for (const kind of ["installed", "cached archive", "other model"]) {
  test(`${kind} does not fetch a manifest`, async (t) => {
    const model = kind === "other model" ? "parakeet-tdt-0.6b-v3" : MODEL;
    const h = setup(t, { model });
    if (kind === "installed") {
      fs.mkdirSync(path.join(h.root, MODEL));
      fs.writeFileSync(path.join(h.root, MODEL, "tokens.txt"), "installed");
    }
    if (kind === "cached archive") {
      const archive = path.join(h.root, `${MODEL}.tar.bz2`);
      fs.writeFileSync(archive, "");
      fs.truncateSync(archive, info.expectedSizeBytes);
    }
    assert.equal((await h.manager.downloadParakeetModel(model)).success, true);
    assert.equal(h.calls.manifests.length, 0);
    if (kind !== "other model") assert.equal(h.calls.downloads.length, 0);
  });
}

for (const option of ["cancel", "downloadError", "extractionError"]) {
  test(`${option} does not fetch a manifest or leave the download locked`, async (t) => {
    const h = setup(t, { [option]: true });
    await assert.rejects(h.manager.downloadParakeetModel(MODEL));
    assert.equal(h.calls.manifests.length, 0);
    assert.equal(h.manager.currentDownloadProcess, null);
  });
}

test("an extraction retry fetches only one manifest", async (t) => {
  const h = setup(t, { retryExtraction: true });
  assert.equal((await h.manager.downloadParakeetModel(MODEL)).success, true);
  await h.settled();
  assert.equal(h.calls.manifests.length, 1);
});

test("a truncated cached archive is downloaded again and gets one manifest", async (t) => {
  const h = setup(t);
  fs.writeFileSync(path.join(h.root, `${MODEL}.tar.bz2`), "incomplete");
  await h.manager.downloadParakeetModel(MODEL);
  await h.settled();
  assert.equal(h.calls.downloads.length, 1);
  assert.equal(h.calls.manifests.length, 1);
});

test(
  "a stalled manifest cannot delay successful installation or warmup",
  { timeout: 2000 },
  async (t) => {
    const h = setup(t, {
      fetch: (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });
    t.after(() => h.timeout.abort());
    const result = await h.manager.downloadParakeetModel(MODEL);
    assert.equal(result.success, true);
    assert.equal(h.calls.warms, 1);
    assert.equal(h.manager.currentDownloadProcess, null);
    h.timeout.abort(new Error("timeout"));
    await h.settled();
    assert.equal(h.calls.manifests.length, 1);
    assert.equal(h.calls.errors.length, 1);
    assert.equal(fs.existsSync(h.sidecar), false);
  }
);

const failures = [
  [
    "network rejection",
    {
      fetch: async () => {
        throw new Error("offline");
      },
    },
  ],
  ["HTTP 404", { fetch: async () => new Response("missing", { status: 404 }) }],
  ["invalid JSON", { fetch: async () => new Response("not json") }],
  ["null manifest", { fetch: async () => Response.json(null) }],
  [
    "wrong archive",
    { fetch: async () => Response.json({ ...manifest, archive: "other.tar.bz2" }) },
  ],
  ["wrong directory", { fetch: async () => Response.json({ ...manifest, extract_dir: "other" }) }],
  ["wrong size", { fetch: async () => Response.json({ ...manifest, archive_bytes: 1 }) }],
  ["invalid digest", { fetch: async () => Response.json({ ...manifest, archive_sha256: "bad" }) }],
  ["sidecar write failure", { writeError: true }],
];
for (const [label, options] of failures) {
  test(`${label} leaves the installed model usable`, async (t) => {
    const h = setup(t, options);
    assert.equal((await h.manager.downloadParakeetModel(MODEL)).success, true);
    await h.settled();
    assert.equal(h.calls.manifests.length, 1);
    assert.equal(h.calls.errors.length, 1);
    assert.equal(h.calls.warms, 1);
    assert.equal(h.manager.serverManager.isModelDownloaded(MODEL), true);
    assert.equal(fs.existsSync(h.sidecar), false);
    assert.equal(h.manager.currentDownloadProcess, null);
  });
}

test("a late manifest never recreates a deleted model directory", async (t) => {
  let finish;
  const h = setup(t, {
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await h.manager.downloadParakeetModel(MODEL);
  fs.rmSync(path.join(h.root, MODEL), { recursive: true });
  finish(Response.json(manifest));
  await h.settled();
  assert.equal(fs.existsSync(path.join(h.root, MODEL)), false);
  assert.equal(h.calls.errors.length, 1);
});

test("a late manifest never overwrites an existing sidecar", async (t) => {
  let finish;
  const h = setup(t, {
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await h.manager.downloadParakeetModel(MODEL);
  fs.writeFileSync(h.sidecar, "existing provenance");
  finish(Response.json(manifest));
  await h.settled();
  assert.equal(fs.readFileSync(h.sidecar, "utf8"), "existing provenance");
});

test("manifest collection does not hijack a running model server", async (t) => {
  const h = setup(t, { running: true });
  await h.manager.downloadParakeetModel(MODEL);
  await h.settled();
  assert.equal(h.calls.warms, 0);
  assert.equal(h.calls.manifests.length, 1);
});
