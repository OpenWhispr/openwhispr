const test = require("node:test");
const assert = require("node:assert/strict");
const WhisperManager = require("../../src/helpers/whisper");
const ParakeetManager = require("../../src/helpers/parakeet");
const WhisperServer = require("../../src/helpers/whisperServer");
const ParakeetWsServer = require("../../src/helpers/parakeetWsServer");
const LlamaServer = require("../../src/helpers/llamaServer");
const modelManager = require("../../src/helpers/modelManagerBridge").default;
const { createLocalModelPolicyGate } = require("../../src/helpers/localModelPolicyGate");
const { managedPolicy } = require("./harness/policyFixtures");

function deniedGate() {
  return createLocalModelPolicyGate({
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
    getPolicy: async () => ({
      success: true,
      managed: true,
      authGeneration: 1,
      policy: managedPolicy({
        transcription: { allowedModes: ["local"], allowedLocalModels: [] },
        llm: { allowedModes: ["local"], allowedLocalModels: [] },
      }),
    }),
  });
}

test("public speech start reports policy denial before checking whether a model is installed", async () => {
  for (const [manager, model] of [
    [new WhisperManager(), "base"],
    [new ParakeetManager(), "parakeet-tdt-0.6b-v3"],
  ]) {
    manager.localModelPolicy = deniedGate();
    const result = await manager.startServer(model);
    assert.equal(result.success, false);
    assert.equal(result.code, "POLICY_MODEL_BLOCKED");
  }
});

test("blocked speech operations cannot download, start, or reuse a native server", async () => {
  const whisper = new WhisperManager();
  const parakeet = new ParakeetManager();
  const whisperServer = new WhisperServer();
  const parakeetServer = new ParakeetWsServer();
  const llamaServer = new LlamaServer();
  modelManager.localModelPolicy = deniedGate();
  for (const owner of [whisper, parakeet, whisperServer, parakeetServer, llamaServer]) {
    owner.localModelPolicy = deniedGate();
    owner.ready = true;
    owner.process = {};
    owner.localModelIdForPath = () => (owner === llamaServer ? "qwen3.5-0.8b-q4_k_m" : "base");
  }
  for (const operation of [
    () => whisper.downloadWhisperModel("base"),
    () => whisper._runServerTranscription(Buffer.alloc(1), "base", "en"),
    () => parakeet.downloadParakeetModel("parakeet-tdt-0.6b-v3"),
    () => parakeet.transcribeLocalParakeet(Buffer.alloc(1), { model: "parakeet-tdt-0.6b-v3" }),
    () => parakeet.createOnlineStream("parakeet-tdt-0.6b-v3"),
    () => whisperServer.start("/blocked/base.bin"),
    () => whisperServer.transcribe(Buffer.alloc(1)),
    () => parakeetServer.start("parakeet-tdt-0.6b-v3", "/blocked"),
    () => parakeetServer.transcribe(Buffer.alloc(1), 16000),
    () => llamaServer.start("/blocked/model.gguf"),
    () => llamaServer.inference([]),
    () => modelManager.downloadModel("qwen3.5-0.8b-q4_k_m"),
    () => modelManager.runInference("qwen3.5-0.8b-q4_k_m", "hello"),
  ])
    await assert.rejects(operation(), { code: "POLICY_MODEL_BLOCKED" });
});

test("Whisper suppresses an inference result returned after a policy revocation", async () => {
  const gate = createLocalModelPolicyGate({
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
    getPolicy: async () => ({ success: true, managed: false }),
  });
  const whisper = new WhisperManager();
  whisper.localModelPolicy = gate;
  let finish;
  let began;
  const started = new Promise((done) => {
    began = done;
  });
  let stopped = 0;
  whisper.serverManager = {
    start: async () => {},
    stop: async () => {
      stopped++;
    },
    transcribe: async () => {
      began();
      return new Promise((done) => {
        finish = done;
      });
    },
  };
  const result = whisper._runServerTranscription(Buffer.from([1]), "base", "en");
  await started;
  gate.update({
    success: true,
    managed: true,
    policy: managedPolicy({ transcription: { allowedModes: ["local"], allowedLocalModels: [] } }),
  });
  finish({ text: "must not escape" });
  await assert.rejects(result, { code: "POLICY_MODEL_BLOCKED" });
  assert.equal(stopped, 1);
});

test("revocation cancels active work and refuses its late result", async () => {
  const { runLocalModelOperation } = require("../../src/helpers/localModelPolicyGate");
  const gate = createLocalModelPolicyGate({
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
    getPolicy: async () => ({ success: true, managed: false, authGeneration: 1 }),
  });
  let finish;
  let began;
  const started = new Promise((done) => {
    began = done;
  });
  let aborted = false;
  const result = runLocalModelOperation(
    { localModelPolicy: gate },
    "transcription",
    "base",
    async () => {
      began();
      return new Promise((done) => {
        finish = done;
      });
    },
    {
      onAbort: () => {
        aborted = true;
      },
    }
  );
  await started;
  gate.update({
    success: true,
    managed: true,
    authGeneration: 1,
    policy: managedPolicy({ transcription: { allowedModes: ["local"], allowedLocalModels: [] } }),
  });
  finish("late text");
  await assert.rejects(result, { code: "POLICY_MODEL_BLOCKED" });
  assert.equal(aborted, true);
});

const unmanagedGate = () =>
  createLocalModelPolicyGate({
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
    getPolicy: async () => ({ success: true, managed: false, authGeneration: 1 }),
  });

const managedGate = (allowedLocalModels = ["base", "parakeet-tdt-0.6b-v3"]) =>
  createLocalModelPolicyGate({
    getIdentity: () => 1,
    getAppVersion: () => "1.11.1",
    getPolicy: async () => ({
      success: true,
      managed: true,
      authGeneration: 1,
      policy: managedPolicy({
        transcription: { allowedModes: ["local"], allowedLocalModels },
        llm: { allowedModes: ["local"], allowedLocalModels },
      }),
    }),
  });

test("a server stopped before its request answers not running, not a policy refusal", async () => {
  const whisperServer = new WhisperServer();
  const parakeetServer = new ParakeetWsServer();
  const llamaServer = new LlamaServer();
  for (const owner of [whisperServer, parakeetServer, llamaServer]) {
    owner.localModelPolicy = managedGate();
    owner.localModelIdForPath = () => undefined;
  }
  await assert.rejects(whisperServer.transcribe(Buffer.alloc(1)), (error) => {
    assert.equal(error.code, undefined);
    assert.match(error.message, /not running/);
    return true;
  });
  await assert.rejects(parakeetServer.transcribe(Buffer.alloc(1), 16000), (error) => {
    assert.equal(error.code, undefined);
    assert.match(error.message, /not running/);
    return true;
  });
  await assert.rejects(llamaServer.inference([]), (error) => {
    assert.equal(error.code, undefined);
    assert.match(error.message, /not running/);
    return true;
  });
});

test("with no managed policy a blank speech model reaches the engine default, as before", async (t) => {
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs");
  const modelsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "blank-model-"));
  t.after(() => fs.rmSync(modelsDirectory, { recursive: true, force: true }));

  const whisper = new WhisperManager();
  whisper.localModelPolicy = unmanagedGate();
  whisper.getModelsDir = () => modelsDirectory;
  fs.writeFileSync(whisper.getModelPath("base"), "weights");
  whisper.serverManager.isAvailable = () => true;
  let whisperModel;
  whisper.transcribeViaServer = async (_audio, model) => {
    whisperModel = model;
    return { success: true, text: "" };
  };
  await whisper.transcribeLocalWhisper(Buffer.alloc(1), {});
  assert.equal(whisperModel, "base");

  const parakeet = new ParakeetManager();
  parakeet.localModelPolicy = unmanagedGate();
  parakeet.serverManager.isAvailable = () => true;
  let checkedModel;
  parakeet.serverManager.isModelDownloaded = (model) => {
    checkedModel = model;
    return false;
  };
  await assert.rejects(parakeet.transcribeLocalParakeet(Buffer.alloc(1), {}), /not downloaded/);
  assert.equal(checkedModel, "parakeet-tdt-0.6b-v3");

  for (const [manager, operation] of [
    [new WhisperManager(), (m) => m.transcribeLocalWhisper(Buffer.alloc(1), {})],
    [new ParakeetManager(), (m) => m.transcribeLocalParakeet(Buffer.alloc(1), {})],
  ]) {
    manager.localModelPolicy = managedGate();
    await assert.rejects(operation(manager), { code: "POLICY_MODEL_BLOCKED" });
  }
});

function warmUpScenarios(t) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const modelsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "warm-up-"));
  t.after(() => fs.rmSync(modelsDirectory, { recursive: true, force: true }));

  const pendingGate = () =>
    createLocalModelPolicyGate({
      getIdentity: () => 1,
      getAppVersion: () => "1.11.1",
      getPolicy: () => new Promise(() => {}),
    });
  const quietStartup = (manager) => {
    manager.logDependencyStatus = async () => {};
    manager.getModelsDir = () => modelsDirectory;
  };

  return {
    whisper() {
      const manager = new WhisperManager();
      quietStartup(manager);
      fs.writeFileSync(manager.getModelPath("base"), "weights");
      const server = manager.serverManager;
      const gate = pendingGate();
      manager.localModelPolicy = gate;
      server.localModelPolicy = gate;
      server.localModelIdForPath = () => "base";
      server.isAvailable = () => true;
      const starts = [];
      server._policyAllowedStart = async (modelPath, options) => {
        starts.push({ modelPath, options });
        server.ready = true;
      };
      return {
        gate,
        starts,
        scope: "transcription",
        model: "base",
        begin: () =>
          manager.initializeAtStartup({
            localTranscriptionProvider: "whisper",
            whisperModel: "base",
          }),
        startedByDictation() {
          server.ready = true;
        },
      };
    },
    parakeet() {
      const manager = new ParakeetManager();
      quietStartup(manager);
      const server = manager.serverManager;
      const gate = pendingGate();
      manager.localModelPolicy = gate;
      server.localModelPolicy = gate;
      server.isAvailable = () => true;
      server.isModelDownloaded = () => true;
      let running = false;
      server.getServerStatus = () => ({ running, starting: false });
      const starts = [];
      server.startServer = async (modelName, language) => {
        starts.push({ modelName, language });
        running = true;
        return { success: true };
      };
      return {
        gate,
        starts,
        scope: "transcription",
        model: "parakeet-tdt-0.6b-v3",
        begin: () =>
          manager.initializeAtStartup({
            localTranscriptionProvider: "nvidia",
            parakeetModel: "parakeet-tdt-0.6b-v3",
            language: "de",
          }),
        startedByDictation() {
          running = true;
        },
      };
    },
    gguf() {
      const manager = new modelManager.constructor();
      const gate = pendingGate();
      manager.localModelPolicy = gate;
      const starts = [];
      manager._policyAllowedPrewarmServer = async (modelId) => {
        starts.push({ modelId });
        manager.serverManager.ready = true;
        return true;
      };
      return {
        gate,
        starts,
        scope: "llm",
        model: "qwen3.5-0.8b-q4_k_m",
        begin: () => manager.prewarmServer("qwen3.5-0.8b-q4_k_m").catch(() => false),
        startedByDictation() {
          manager.serverManager.ready = true;
        },
      };
    },
  };
}

const settle = async () => {
  for (let turn = 0; turn < 5; turn++) await new Promise((done) => setImmediate(done));
};

const WARM_UP_ENGINES = ["whisper", "parakeet", "gguf"];

for (const engine of WARM_UP_ENGINES) {
  test(`${engine}: a warm-up skipped before policy settled runs once on the first verdict`, async (t) => {
    const scenario = warmUpScenarios(t)[engine]();
    await scenario.begin();
    assert.equal(scenario.starts.length, 0, "nothing starts on an unsettled policy");

    scenario.gate.update({ success: true, managed: false, authGeneration: 1, revision: 1 });
    await settle();
    assert.equal(scenario.starts.length, 1);

    scenario.gate.update({ success: true, managed: false, authGeneration: 1, revision: 2 });
    await settle();
    assert.equal(scenario.starts.length, 1, "never twice");
  });

  test(`${engine}: a denial doesn't resume a skipped warm-up, nor does a later approval`, async (t) => {
    const scenario = warmUpScenarios(t)[engine]();
    await scenario.begin();

    const verdict = (allowedLocalModels, revision) => ({
      success: true,
      managed: true,
      authGeneration: 1,
      revision,
      policy: managedPolicy({ [scenario.scope]: { allowedModes: ["local"], allowedLocalModels } }),
    });
    scenario.gate.update(verdict([], 1));
    await settle();
    assert.equal(scenario.starts.length, 0);

    scenario.gate.update(verdict([scenario.model], 2));
    await settle();
    assert.equal(scenario.starts.length, 0);
  });

  test(`${engine}: a dictation that started the server first leaves the resume nothing to do`, async (t) => {
    const scenario = warmUpScenarios(t)[engine]();
    await scenario.begin();
    scenario.startedByDictation();

    scenario.gate.update({ success: true, managed: false, authGeneration: 1, revision: 1 });
    await settle();
    assert.equal(scenario.starts.length, 0);
  });
}

test("a resumed warm-up keeps exactly what startup would have warmed", async (t) => {
  const scenarios = warmUpScenarios(t);
  const whisper = scenarios.whisper();
  await whisper.begin();
  whisper.gate.update({ success: true, managed: false, authGeneration: 1 });
  await settle();
  assert.match(whisper.starts[0].modelPath, /ggml-base\.bin$/);
  assert.equal(whisper.starts[0].options.policyMemoryOnly, true);

  const parakeet = scenarios.parakeet();
  await parakeet.begin();
  parakeet.gate.update({ success: true, managed: false, authGeneration: 1 });
  await settle();
  assert.deepEqual(parakeet.starts, [{ modelName: "parakeet-tdt-0.6b-v3", language: "de" }]);

  const gguf = scenarios.gguf();
  await gguf.begin();
  gguf.gate.update({ success: true, managed: false, authGeneration: 1 });
  await settle();
  assert.deepEqual(gguf.starts, [{ modelId: "qwen3.5-0.8b-q4_k_m" }]);
});
