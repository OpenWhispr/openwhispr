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
