const test = require("node:test");
const assert = require("node:assert/strict");
const { getEventListeners } = require("node:events");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { managedPolicy } = require("./harness/policyFixtures");

const scratchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "local-model-download-"));
const originalLoad = Module._load;

// Electron's net.request over node:http, so the real downloadFile runs against
// a real server: same response stream, same abort.
const electronStub = {
  app: {
    isReady: () => true,
    getPath: () => scratchDirectory,
    getAppPath: () => process.cwd(),
    getName: () => "test",
    getVersion: () => "1.11.1",
    isPackaged: false,
    on: () => {},
  },
  session: { fromPartition: () => ({}) },
  net: {
    request({ url, method }) {
      const headers = {};
      const parsed = new URL(url);
      const listeners = {};
      let request = null;
      return {
        setHeader: (name, value) => {
          headers[name] = value;
        },
        on(event, listener) {
          listeners[event] = listener;
        },
        abort() {
          request?.destroy();
        },
        end() {
          request = http.request(
            { host: parsed.hostname, port: parsed.port, path: parsed.pathname, method, headers },
            (response) => listeners.response?.(response)
          );
          request.on("error", (error) => listeners.error?.(error));
          request.end();
        },
      };
    },
  },
};

Module._load = function loadWithElectronStub(request, parent, isMain) {
  if (request === "electron") return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

const WhisperManager = require("../../src/helpers/whisper");
const ParakeetManager = require("../../src/helpers/parakeet");
const modelManager = require("../../src/helpers/modelManagerBridge").default;
const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
const { getRequiredModelFiles } = require("../../src/helpers/parakeetModelInfo");
const modelRegistryData = require("../../src/models/modelRegistryData.json");
const { getRegistryVersion, replaceRegistryData } = require("../../src/models/registryData.js");

// The managers read the live catalog, whose entries are frozen once applied.
function pointCatalogAt(section, modelId, downloadUrl, expectedSizeBytes) {
  const data = structuredClone(modelRegistryData);
  Object.assign(data[section][modelId], { downloadUrl, expectedSizeBytes });
  delete data[section][modelId].manifestUrl;
  replaceRegistryData({ data, manifestVersion: getRegistryVersion() + 1 });
}

const WHISPER_MODEL = "base";
const PARAKEET_MODEL = "parakeet-tdt-110m-en";
const GGUF_MODEL = "gemma-4-e2b-it-qat-q4_0";
// downloadModel discards anything smaller as corrupted.
const GGUF_BODY = Buffer.alloc(2 * 1024 * 1024, 7);
const WHISPER_BODY = Buffer.alloc(256 * 1024, 3);

const routes = new Map();
const server = http.createServer((request, response) => {
  const route = routes.get(request.url);
  if (typeof route === "function") route(request, response);
  else {
    response.writeHead(404);
    response.end();
  }
});
let baseUrl;

const serve = (body) => (_request, response) => {
  response.writeHead(200, { "Content-Length": body.length });
  response.end(body);
};
// Sends half the body, then holds the connection open: a transfer in flight.
const stall = (body) => (_request, response) => {
  response.writeHead(200, { "Content-Length": body.length });
  response.write(body.subarray(0, Math.floor(body.length / 2)));
};

async function until(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((done) => setTimeout(done, 5));
  }
}

const partialStarted = (filePath) => () =>
  fs.existsSync(`${filePath}.tmp`) && fs.statSync(`${filePath}.tmp`).size > 0;

function allowingGate(scope, modelId) {
  let verdict = { success: true, managed: false, authGeneration: 1, revision: 1 };
  const released = [];
  const gate = createLocalModelPolicyGate({
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
    getPolicy: async () => verdict,
  });
  const release = gate.release;
  gate.release = (lease) => {
    released.push({ scope: lease.scope, listeners: getEventListeners(lease.signal, "abort") });
    release(lease);
  };
  return {
    gate,
    released,
    revoke() {
      verdict = {
        success: true,
        managed: true,
        authGeneration: 1,
        revision: 2,
        policy: managedPolicy({ [scope]: { allowedModes: ["local"], allowedLocalModels: [] } }),
      };
      gate.update(verdict);
    },
    approve() {
      verdict = {
        success: true,
        managed: true,
        authGeneration: 1,
        revision: 3,
        policy: managedPolicy({
          [scope]: { allowedModes: ["local"], allowedLocalModels: [modelId] },
        }),
      };
      gate.update(verdict);
    },
  };
}

let parakeetArchive;

function directory(label) {
  return fs.mkdtempSync(path.join(scratchDirectory, `${label}-`));
}

function whisperEngine() {
  const manager = new WhisperManager();
  const modelsDirectory = directory("whisper");
  manager.getModelsDir = () => modelsDirectory;
  pointCatalogAt("whisperModels", WHISPER_MODEL, `${baseUrl}/whisper.bin`, WHISPER_BODY.length);
  const policy = allowingGate("transcription", WHISPER_MODEL);
  manager.localModelPolicy = policy.gate;
  return {
    policy,
    route: "/whisper.bin",
    body: WHISPER_BODY,
    transferPath: manager.getModelPath(WHISPER_MODEL),
    download: () => manager.downloadWhisperModel(WHISPER_MODEL),
    cancel: () => manager.cancelDownload(),
    isIdle: () => manager.currentDownloadProcess === null,
    installedPath: () => manager.getModelPath(WHISPER_MODEL),
  };
}

function parakeetEngine() {
  const manager = new ParakeetManager();
  const modelsDirectory = directory("parakeet");
  manager.getModelsDir = () => modelsDirectory;
  manager.serverManager.getModelsDir = () => modelsDirectory;
  manager.serverManager.isAvailable = () => false;
  pointCatalogAt(
    "parakeetModels",
    PARAKEET_MODEL,
    `${baseUrl}/parakeet.tar.bz2`,
    parakeetArchive.length
  );
  const policy = allowingGate("transcription", PARAKEET_MODEL);
  manager.localModelPolicy = policy.gate;
  return {
    manager,
    policy,
    route: "/parakeet.tar.bz2",
    body: parakeetArchive,
    transferPath: path.join(modelsDirectory, `${PARAKEET_MODEL}.tar.bz2`),
    download: () => manager.downloadParakeetModel(PARAKEET_MODEL),
    cancel: () => manager.cancelDownload(),
    isIdle: () => manager.currentDownloadProcess === null,
    installedPath: () => manager.getModelPath(PARAKEET_MODEL),
  };
}

function ggufEngine() {
  const manager = new modelManager.constructor();
  const modelsDirectory = directory("gguf");
  manager.getModelsDir = () => modelsDirectory;
  const { model } = (() => {
    manager.ensureInitialized();
    return manager.findModelById(GGUF_MODEL);
  })();
  model.sizeBytes = GGUF_BODY.length;
  model.draftSizeBytes = GGUF_BODY.length;
  manager.getDownloadUrl = () => `${baseUrl}/model.gguf`;
  manager.getDraftDownloadUrl = () => `${baseUrl}/draft.gguf`;
  const policy = allowingGate("llm", GGUF_MODEL);
  manager.localModelPolicy = policy.gate;
  routes.set("/draft.gguf", serve(GGUF_BODY));
  return {
    manager,
    policy,
    route: "/model.gguf",
    body: GGUF_BODY,
    transferPath: path.join(modelsDirectory, model.fileName),
    draftPath: path.join(modelsDirectory, model.draftFileName),
    download: () => manager.downloadModel(GGUF_MODEL),
    cancel: () => manager.cancelDownload(GGUF_MODEL),
    isIdle: () =>
      manager.activeDownloads.size === 0 &&
      manager.activeRequests.size === 0 &&
      manager.downloadReservations.size === 0,
    installedPath: () => path.join(modelsDirectory, model.fileName),
  };
}

const ENGINES = { whisper: whisperEngine, parakeet: parakeetEngine, gguf: ggufEngine };

test.before(async () => {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const archiveRoot = directory("parakeet-archive");
  const extractDirectory = modelRegistryData.parakeetModels[PARAKEET_MODEL].extractDir;
  fs.mkdirSync(path.join(archiveRoot, extractDirectory));
  for (const file of getRequiredModelFiles(PARAKEET_MODEL)) {
    fs.writeFileSync(path.join(archiveRoot, extractDirectory, file), "weights");
  }
  const archivePath = path.join(archiveRoot, "archive.tar.bz2");
  execFileSync("tar", ["-cjf", archivePath, "-C", archiveRoot, extractDirectory]);
  parakeetArchive = fs.readFileSync(archivePath);
});

test.after(async () => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  Module._load = originalLoad;
  fs.rmSync(scratchDirectory, { recursive: true, force: true });
});

for (const [name, build] of Object.entries(ENGINES)) {
  test(`${name}: an allowed download completes through the gate`, async () => {
    const engine = build();
    routes.set(engine.route, serve(engine.body));

    await engine.download();

    assert.equal(fs.existsSync(engine.installedPath()), true);
    assert.equal(fs.existsSync(`${engine.transferPath}.tmp`), false);
    assert.equal(engine.isIdle(), true);
    if (engine.draftPath) assert.equal(fs.existsSync(engine.draftPath), true);
    for (const { listeners } of engine.policy.released) assert.deepEqual(listeners, []);
  });

  test(`${name}: a user cancel aborts the transfer and is reported as cancelled`, async () => {
    const engine = build();
    routes.set(engine.route, stall(engine.body));

    const download = engine.download();
    await until(partialStarted(engine.transferPath));
    await engine.cancel();

    await assert.rejects(download, { code: "DOWNLOAD_CANCELLED" });
    assert.equal(fs.existsSync(`${engine.transferPath}.tmp`), false);
    assert.equal(engine.isIdle(), true);

    routes.set(engine.route, serve(engine.body));
    await engine.download();
    assert.equal(fs.existsSync(engine.installedPath()), true);
  });

  test(`${name}: a revocation mid-transfer aborts it with the policy code, not a cancel`, async () => {
    const engine = build();
    routes.set(engine.route, stall(engine.body));

    const download = engine.download();
    await until(partialStarted(engine.transferPath));
    engine.policy.revoke();

    await assert.rejects(download, { code: "POLICY_MODEL_BLOCKED" });
    assert.equal(fs.existsSync(`${engine.transferPath}.tmp`), false);
    assert.equal(fs.existsSync(engine.installedPath()), false);
    assert.equal(engine.isIdle(), true);
    for (const { listeners } of engine.policy.released) assert.deepEqual(listeners, []);

    engine.policy.approve();
    routes.set(engine.route, serve(engine.body));
    await engine.download();
    assert.equal(fs.existsSync(engine.installedPath()), true);
  });
}

test("gguf: the companion draft stops with the same revocation and keeps the finished model", async () => {
  const engine = ggufEngine();
  routes.set(engine.route, serve(engine.body));
  routes.set("/draft.gguf", stall(engine.body));

  const download = engine.download();
  await until(partialStarted(engine.draftPath));
  engine.policy.revoke();

  await assert.rejects(download, { code: "POLICY_MODEL_BLOCKED" });
  assert.equal(fs.existsSync(`${engine.draftPath}.tmp`), false);
  assert.equal(fs.existsSync(engine.draftPath), false);
  assert.equal(fs.statSync(engine.transferPath).size, engine.body.length);
  assert.equal(engine.isIdle(), true);
});

test("gguf: a user cancel during the companion draft keeps the finished model", async () => {
  const engine = ggufEngine();
  routes.set(engine.route, serve(engine.body));
  routes.set("/draft.gguf", stall(engine.body));

  const download = engine.download();
  await until(partialStarted(engine.draftPath));
  await engine.cancel();

  await assert.rejects(download, { code: "DOWNLOAD_CANCELLED" });
  assert.equal(fs.existsSync(`${engine.draftPath}.tmp`), false);
  assert.equal(fs.statSync(engine.transferPath).size, engine.body.length);
  assert.equal(engine.isIdle(), true);
});

test("gguf: a failed download clears its slot, so a retry isn't reported as in progress", async () => {
  const engine = ggufEngine();
  routes.delete(engine.route);

  await assert.rejects(engine.download(), { code: "DOWNLOAD_FAILED" });
  assert.equal(engine.isIdle(), true);

  routes.set(engine.route, serve(engine.body));
  await engine.download();
  assert.equal(fs.existsSync(engine.installedPath()), true);
});

test("gguf: a revocation before the transfer starts takes no download slot", async () => {
  const engine = ggufEngine();
  routes.set(engine.route, serve(engine.body));
  const checkModelValid = engine.manager.checkModelValid.bind(engine.manager);
  engine.manager.checkModelValid = async (modelPath) => {
    engine.policy.revoke();
    return checkModelValid(modelPath);
  };

  await assert.rejects(engine.download(), { code: "POLICY_MODEL_BLOCKED" });
  assert.equal(engine.isIdle(), true);
  assert.equal(fs.existsSync(engine.transferPath), false);
});

test("parakeet: a revocation during extraction kills tar and keeps the finished archive", async (t) => {
  const fakeBin = directory("fake-tar");
  const started = path.join(fakeBin, "started");
  fs.writeFileSync(path.join(fakeBin, "tar"), `#!/bin/sh\ntouch "${started}"\nexec sleep 30\n`, {
    mode: 0o755,
  });
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const engine = parakeetEngine();
  routes.set(engine.route, serve(engine.body));

  const startedAt = Date.now();
  const download = engine.download();
  await until(() => fs.existsSync(started));
  engine.policy.revoke();

  await assert.rejects(download, { code: "POLICY_MODEL_BLOCKED" });
  assert.ok(Date.now() - startedAt < 10_000, "tar must not run to its timeout");
  assert.equal(fs.existsSync(engine.transferPath), true);
  assert.equal(
    fs.existsSync(path.join(engine.manager.getModelsDir(), `temp-extract-${PARAKEET_MODEL}`)),
    false
  );
  assert.equal(engine.isIdle(), true);
});
