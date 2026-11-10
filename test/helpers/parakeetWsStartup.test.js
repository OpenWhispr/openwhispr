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
    "./parakeetModelInfo": modelInfo,
    "./debugLogger": { debug() {}, info() {} },
    "./sidecarPidFile": { write() {} },
    "./safeTempDir": { getSafeTempDir: () => os.tmpdir() },
    "../utils/serverUtils": {
      findAvailablePort: async () => 6006,
      getAvailableParallelism: () => 8,
    },
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

for (const modelName of ["parakeet-tdt-0.6b-v3", "orukeet-v0.1.0"]) {
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
      "--num-work-threads=3",
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
    "--num-work-threads=3",
  ]);
});

test("online startup preserves its scheduling flags and omits offline decoder hints", async () => {
  for (const modelName of ["nemotron-speech-streaming-en-0.6b", "orukeet-v0.1.0"]) {
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

const ORUKEET_HOTWORDS = { score: 2, words: ["Schellhas", "Kisfeld"] };

// A running server whose spawns are recorded, with the hotwords file each one
// was given read at spawn time (the server deletes it once it is ready).
function hotwordsServer({ withBpeVocab = true, failReadyWhen = () => false } = {}) {
  const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "parakeet-model-"));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "parakeet-temp-"));
  if (withBpeVocab) fs.writeFileSync(path.join(modelDir, "bpe.vocab"), "▁s\t-1.0\n");
  const spawns = [];
  const Server = loadHelper("parakeetWsServer", {
    child_process: {
      spawn: (binary, args) => {
        const hotwordsArg = args.find((arg) => arg.startsWith("--hotwords-file="));
        const hotwordsFile = hotwordsArg?.slice("--hotwords-file=".length);
        spawns.push({
          args: Array.from(args),
          hotwordsFile,
          hotwordsContent: hotwordsFile ? fs.readFileSync(hotwordsFile, "utf8") : null,
          fileMode: hotwordsFile ? fs.statSync(hotwordsFile).mode & 0o777 : null,
          dirMode: hotwordsFile ? fs.statSync(path.dirname(hotwordsFile)).mode & 0o777 : null,
        });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        return child;
      },
    },
    "./debugLogger": { debug() {}, info() {}, warn() {}, error() {} },
    "./sidecarPidFile": { write() {}, clear() {} },
    "./safeTempDir": { getSafeTempDir: () => tempDir },
    "../utils/serverUtils": {
      findAvailablePort: async () => 6006,
      getAvailableParallelism: () => 8,
      gracefulStopProcess: async () => {},
    },
  });
  const server = new Server();
  server.getWsBinaryPath = (mode) => `sherpa-${mode}`;
  server._waitForReady = async function () {
    if (failReadyWhen(spawns.at(-1))) throw new Error("parakeet-ws process died during startup");
    this.ready = true;
  };
  server._startHealthCheck = () => {};
  server._warmUp = async () => {};
  const start = (hotwords) => server.start("orukeet-v0.1.0", modelDir, "offline", null, hotwords);
  return { server, spawns, start, modelDir, tempDir };
}

test("dictionary hotwords switch Orukeet to beam search with the words as a file", async () => {
  const { spawns, start, modelDir, tempDir } = hotwordsServer();
  await start(ORUKEET_HOTWORDS);

  assert.equal(spawns.length, 1);
  const { args, hotwordsFile, hotwordsContent } = spawns[0];
  assert.deepEqual(args.slice(-5), [
    "--decoding-method=modified_beam_search",
    `--hotwords-file=${hotwordsFile}`,
    "--hotwords-score=2",
    "--modeling-unit=bpe",
    `--bpe-vocab=${path.join(modelDir, "bpe.vocab")}`,
  ]);
  assert.equal(hotwordsContent, "Schellhas\nKisfeld\n");
  // sherpa reads the file once at startup; the words do not stay on disk.
  assert.equal(fs.existsSync(path.dirname(hotwordsFile)), false);
  assert.deepEqual(fs.readdirSync(tempDir), []);
});

test("the hotwords file sits in a folder of its own that only this user can open", async () => {
  const { spawns, start, tempDir } = hotwordsServer();
  await start(ORUKEET_HOTWORDS);
  await start({ score: 2, words: ["Quillfeather"] });

  const [first, second] = spawns;
  const firstDir = path.dirname(first.hotwordsFile);
  // A fresh, randomly named folder per start, so no planted file or link is in the way.
  assert.equal(path.dirname(firstDir), tempDir);
  assert.match(path.basename(firstDir), /^openwhispr-hotwords-/);
  assert.notEqual(path.dirname(second.hotwordsFile), firstDir);
  if (process.platform !== "win32") {
    assert.equal(first.dirMode, 0o700);
    assert.equal(first.fileMode, 0o600);
  }
});

test("a model directory without bpe.vocab starts without hotwords", async () => {
  const { spawns, start } = hotwordsServer({ withBpeVocab: false });
  await start(ORUKEET_HOTWORDS);
  assert.ok(!spawns[0].args.some((arg) => arg.startsWith("--hotwords")));
  assert.ok(!spawns[0].args.includes("--decoding-method=modified_beam_search"));
});

test("the same dictionary keeps the server, a changed one restarts it", async () => {
  const { spawns, start } = hotwordsServer();
  await start(ORUKEET_HOTWORDS);
  await start({ ...ORUKEET_HOTWORDS, words: [...ORUKEET_HOTWORDS.words] });
  assert.equal(spawns.length, 1);

  await start({ score: 2, words: ["Schellhas", "Kisfeld", "Quillfeather"] });
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].hotwordsContent, "Schellhas\nKisfeld\nQuillfeather\n");

  await start(null);
  assert.equal(spawns.length, 3);
  assert.ok(!spawns[2].args.some((arg) => arg.startsWith("--hotwords")));
});

test("a changed dictionary never cuts off a decode in flight", async () => {
  const { server, spawns, start } = hotwordsServer();
  await start(ORUKEET_HOTWORDS);
  let release;
  server._transcribeOffline = () => new Promise((resolve) => (release = resolve));
  const decode = server.transcribe(Buffer.alloc(4), 16000);

  await start({ score: 2, words: ["Quillfeather"] });
  assert.equal(spawns.length, 1);

  release({ text: "ok", elapsed: 1 });
  assert.deepEqual(await decode, { text: "ok", elapsed: 1 });
  await start({ score: 2, words: ["Quillfeather"] });
  assert.equal(spawns.length, 2);
});

test("a startup that fails with hotwords retries once without them", async () => {
  const { spawns, start } = hotwordsServer({
    failReadyWhen: (spawn) => Boolean(spawn.hotwordsFile),
  });
  await start(ORUKEET_HOTWORDS);

  assert.equal(spawns.length, 2);
  assert.ok(spawns[0].hotwordsFile);
  assert.equal(fs.existsSync(spawns[0].hotwordsFile), false);
  assert.ok(!spawns[1].args.some((arg) => arg.startsWith("--hotwords")));

  // The same dictionary is not retried on every decode.
  await start(ORUKEET_HOTWORDS);
  assert.equal(spawns.length, 2);
});
