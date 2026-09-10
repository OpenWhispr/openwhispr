const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const modelData = require("../../src/models/modelRegistryData.json");

function loadHelper(name, mocks) {
  const filename = require.resolve(`../../src/helpers/${name}`);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(filename, "utf8"),
    {
      module,
      require: (request) => mocks[request] ?? localRequire(request),
      process,
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
    { filename }
  );
  return module.exports;
}

async function startupArgs(modelName, runtime = "offline", language = null, registry = modelData) {
  const calls = [];
  const modelInfo = loadHelper("parakeetModelInfo", {
    "../models/modelRegistryData.json": registry,
  });
  const Server = loadHelper("parakeetWsServer", {
    child_process: {
      spawn: (binary, args) => {
        calls.push({ binary, args: Array.from(args) });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        return child;
      },
    },
    os: { cpus: () => Array(8).fill({}) },
    "./parakeetModelInfo": modelInfo,
    "./debugLogger": { debug() {}, info() {} },
    "./sidecarPidFile": { write() {} },
    "./safeTempDir": { getSafeTempDir: () => os.tmpdir() },
    "../utils/serverUtils": { findAvailablePort: async () => 6006 },
  });
  const server = new Server();
  server.getWsBinaryPath = (mode) => `sherpa-${mode}`;
  server._waitForReady = async () => {};
  server._startHealthCheck = () => {};
  server._warmUp = async () => {};
  await server.start(modelName, os.tmpdir(), runtime, language);
  assert.equal(calls.length, 1);
  return calls[0];
}

for (const modelName of ["parakeet-tdt-0.6b-v3", "orukeet-v0.1.0-q8"]) {
  test(`${modelName} starts the offline server with the NeMo decoder hint`, async () => {
    const { binary, args } = await startupArgs(modelName);
    assert.equal(binary, "sherpa-offline");
    assert.deepEqual(args, [
      `--tokens=${path.join(os.tmpdir(), "tokens.txt")}`,
      `--encoder=${path.join(os.tmpdir(), "encoder.int8.onnx")}`,
      `--decoder=${path.join(os.tmpdir(), "decoder.int8.onnx")}`,
      `--joiner=${path.join(os.tmpdir(), "joiner.int8.onnx")}`,
      "--model-type=nemo_transducer",
      "--port=6006",
      "--num-threads=4",
    ]);
  });
}

test("an unhinted offline model retains sherpa metadata detection", async () => {
  const { args } = await startupArgs("parakeet-unified-en-0.6b");
  assert.ok(!args.some((arg) => arg.startsWith("--model-type=")));
  assert.ok(args.includes(`--joiner=${path.join(os.tmpdir(), "joiner.int8.onnx")}`));
});

test("Cohere keeps its language-specific startup arguments", async () => {
  const { args } = await startupArgs("cohere-transcribe-03-2026", "offline", "fr");
  assert.deepEqual(args, [
    `--tokens=${path.join(os.tmpdir(), "tokens.txt")}`,
    `--cohere-transcribe-encoder=${path.join(os.tmpdir(), "encoder.int8.onnx")}`,
    `--cohere-transcribe-decoder=${path.join(os.tmpdir(), "decoder.int8.onnx")}`,
    "--cohere-transcribe-language=fr",
    "--port=6006",
    "--num-threads=4",
  ]);
});

test("online startup preserves its scheduling flags and omits offline decoder hints", async () => {
  for (const modelName of ["nemotron-speech-streaming-en-0.6b", "orukeet-v0.1.0-q8"]) {
    const { binary, args } = await startupArgs(modelName, "online");
    assert.equal(binary, "sherpa-online");
    assert.ok(!args.some((arg) => arg.startsWith("--model-type=")));
    assert.deepEqual(args.slice(-5), [
      "--num-threads=4",
      "--num-work-threads=2",
      "--loop-interval-ms=2",
      "--end-tail-padding=0.6",
      "--warm-up=0",
    ]);
  }
});

test("invalid or incompatible registry hints cannot select a different decoder", async () => {
  for (const entry of [
    { sherpaModelType: "transducer" },
    { sherpaModelType: "nemo_transducer", runtime: "online" },
    { sherpaModelType: "nemo_transducer", modelType: "cohere-transcribe" },
  ]) {
    const { args } = await startupArgs("fixture", "offline", "en", {
      parakeetModels: { fixture: entry },
    });
    assert.ok(!args.some((arg) => arg.startsWith("--model-type=")));
  }
});
